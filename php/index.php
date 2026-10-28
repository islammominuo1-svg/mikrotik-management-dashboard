<?php
header('Content-Type: application/json; charset=utf-8');
$config = require __DIR__ . '/config.php';

try {
    $db = new mysqli(
        $config['db']['host'],
        $config['db']['user'],
        $config['db']['password'],
        $config['db']['name'],
        $config['db']['port']
    );
    if ($db->connect_errno) throw new Exception($db->connect_error);

    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $path = preg_replace('#^/api.php#', '', $path);

    function out($data, $code = 200) {
        http_response_code($code);
        echo json_encode($data, JSON_UNESCAPED_SLASHES);
        exit;
    }

    function getRouter($db, $id) {
        $stmt = $db->prepare("SELECT * FROM routers WHERE id=? AND enabled=1");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $r = $stmt->get_result()->fetch_assoc();
        return $r ?: null;
    }

    function mtRequest($router, $method, $resource, $payload = []) {
        $scheme = ((int)$router['port'] === 443) ? 'https' : 'http';
        $url = $scheme . '://' . $router['host'] . ':' . $router['port'] . '/rest' . $resource;
        $ch = curl_init($url);

        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_USERPWD => $router['username'] . ':' . $router['password'],
            CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => (bool)($router['verify_tls'] ?? false),
            CURLOPT_SSL_VERIFYHOST => (bool)($router['verify_tls'] ?? false) ? 2 : 0,
            CURLOPT_CUSTOMREQUEST => strtoupper($method)
        ];

        if ($method === 'POST' || $method === 'PUT' || $method === 'DELETE') {
            $body = http_build_query($payload, '', '&');
            $options[CURLOPT_POSTFIELDS] = $body;
        }

        curl_setopt_array($ch, $options);
        $body = curl_exec($ch);
        if ($body === false) throw new Exception(curl_error($ch));

        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($status >= 400) {
            throw new Exception("RouterOS HTTP $status: $body");
        }

        $decoded = json_decode($body, true);
        return $decoded !== null ? $decoded : $body;
    }

    function mtGet($router, $resource) {
        return mtRequest($router, 'GET', $resource, []);
    }

    function mtPost($router, $resource, $payload = []) {
        return mtRequest($router, 'POST', $resource, $payload);
    }

    function createSecureApiUser($router, $username = null, $password = null) {
        $username = $username ?: 'dashboard_' . bin2hex(random_bytes(4));
        $password = $password ?: bin2hex(random_bytes(10));

        $payload = [
            'name' => $username,
            'group' => 'full',
            'password' => $password,
            'comment' => 'dashboard secure api user'
        ];

        $result = mtPost($router, '/user/add', $payload);

        return [
            'username' => $username,
            'password' => $password,
            'group' => 'full',
            'result' => $result
        ];
    }

    if ($path === '/routers' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $rows = $db->query("SELECT id,name,host,port,verify_tls,enabled FROM routers ORDER BY id DESC")->fetch_all(MYSQLI_ASSOC);
        out($rows);
    }

    if ($path === '/files' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $routerId = !empty($_GET['router_id']) ? (int)$_GET['router_id'] : 0;
        $router = $routerId ? getRouter($db, $routerId) : null;
        if (!$router) out(['error' => 'Router not found'], 404);

        $files = mtGet($router, '/file');
        out(['router_id' => $router['id'], 'files' => is_array($files) ? $files : []]);
    }

    if ($path === '/files/remove' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $routerId = !empty($_POST['router_id']) ? (int)$_POST['router_id'] : 0;
        $file = $_POST['file'] ?? $_POST['name'] ?? $_POST['number'] ?? null;
        $router = $routerId ? getRouter($db, $routerId) : null;
        if (!$router) out(['error' => 'Router not found'], 404);
        if (!$file) out(['error' => 'File name is required'], 400);

        $result = mtPost($router, '/file/remove', ['number' => $file]);
        out(['ok' => true, 'file' => $file, 'result' => $result]);
    }

    if ($path === '/api-users' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $routerId = !empty($_POST['router_id']) ? (int)$_POST['router_id'] : 0;
        $router = $routerId ? getRouter($db, $routerId) : null;
        if (!$router) out(['error' => 'Router not found'], 404);

        $username = $_POST['username'] ?? null;
        $password = $_POST['password'] ?? null;
        out(createSecureApiUser($router, $username, $password));
    }

    if (preg_match('#^/dashboard/(\\d+)$#', $path, $m)) {
        $router = getRouter($db, (int)$m[1]);
        if (!$router) out(['error'=>'Router not found'], 404);

        $resource = mtGet($router, '/system/resource');
        $interfaces = mtGet($router, '/interface');
        $leases = mtGet($router, '/ip/dhcp-server/lease');
        $hotspot = mtGet($router, '/ip/hotspot/active');
        $vpn = mtGet($router, '/interface/l2tp-server');
        $firewall = mtGet($router, '/ip/firewall/filter');
        $addresses = mtGet($router, '/ip/address');

        $rx = 0; $tx = 0;
        foreach ($interfaces as $i) {
            $rx += (int)($i['rx-byte'] ?? 0);
            $tx += (int)($i['tx-byte'] ?? 0);
        }

        $total = (int)($resource['total-memory'] ?? 0);
        $free = (int)($resource['free-memory'] ?? 0);
        $used = max(0, $total - $free);

        out([
          'router' => ['id'=>$router['id'], 'name'=>$router['name'], 'host'=>$router['host']],
          'resource' => [
            'cpu'=>(float)($resource['cpu-load'] ?? 0),
            'memoryUsed'=>$used,
            'memoryTotal'=>$total,
            'memoryPercent'=>$total ? ($used/$total)*100 : 0,
            'uptime'=>$resource['uptime'] ?? '—',
            'board'=>$resource['board-name'] ?? 'MikroTik'
          ],
          'traffic'=>['rxBytes'=>$rx,'txBytes'=>$tx],
          'sessions'=>[
            'hotspot'=>count($hotspot),
            'dhcp'=>count($leases),
            'vpn'=>count($vpn)
          ],
          'interfaces'=>$interfaces,
          'addresses'=>$addresses,
          'firewall'=>$firewall,
          'generatedAt'=>date(DATE_ATOM)
        ]);
    }

    out(['error'=>'Not found'], 404);
} catch (Throwable $e) {
    out(['error'=>$e->getMessage()], 500);
}
