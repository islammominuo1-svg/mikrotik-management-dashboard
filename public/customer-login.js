(() => {
  if (localStorage.getItem("customerSession")) {
    window.location.replace("/customer.html");
    return;
  }

  const form = document.querySelector("#customerLoginForm");
  const usernameInput = document.querySelector("#customerUsername");
  const passwordInput = document.querySelector("#customerPassword");
  const message = document.querySelector("#loginMessage");
  const submit = document.querySelector("#signInButton");
  const showPassword = document.querySelector("#togglePassword");

  showPassword.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    showPassword.textContent = show ? "Hide" : "Show";
    showPassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.className = "message hidden";
    submit.disabled = true;
    submit.firstElementChild.textContent = "Signing in…";

    try {
      const response = await fetch("/api/customer/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not sign in. Please check your username and password.");
      localStorage.setItem("customerSession", JSON.stringify(data.customer));
      window.location.replace("/customer.html");
    } catch (error) {
      message.textContent = error.message;
      message.className = "message";
      submit.disabled = false;
      submit.firstElementChild.textContent = "Sign in";
    }
  });
})();
