(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('auth-form');
  const tabs = [$('login-tab'), $('signup-tab')];
  const password = $('password');
  const toggle = document.querySelector('.password-toggle');
  let mode = 'login';
  function clearErrors() {
    document.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((element) => element.removeAttribute('aria-invalid'));
    $('form-status').hidden = true;
  }
  function setMode(nextMode) {
    mode = nextMode === 'signup' ? 'signup' : 'login';
    const signup = mode === 'signup';
    document.body.classList.toggle('signup', signup);
    document.querySelectorAll('.signup-only').forEach((element) => { element.hidden = !signup; });
    document.querySelectorAll('.login-only').forEach((element) => { element.hidden = signup; });
    $('full-name').disabled = !signup;
    $('full-name').required = signup;
    tabs.forEach((tab, index) => {
      const active = index === (signup ? 1 : 0);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('auth-panel').setAttribute('aria-labelledby', signup ? 'signup-tab' : 'login-tab');
    $('form-heading').textContent = signup ? 'Your next chapter.' : 'Welcome back.';
    $('form-description').textContent = signup ? 'A little curiosity can go a long way. Start here.' : 'Good to see you again. Let’s pick up where you left off.';
    $('submit-button').textContent = signup ? 'Create account' : 'Log in';
    $('mode-prompt-copy').textContent = signup ? 'Already part of Vertex?' : 'New to Vertex?';
    $('alternate-mode').textContent = signup ? 'Log in' : 'Create an account';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    password.placeholder = signup ? 'Create a password' : 'Enter your password';
    password.value = '';
    password.type = 'password';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
    document.title = signup ? 'Create your account · Vertex' : 'Welcome back · Vertex';
    clearErrors();
  }
  function navigate(nextMode) {
    if (location.hash === '#' + nextMode) setMode(nextMode);
    else location.hash = nextMode;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => navigate(index ? 'signup' : 'login'));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      navigate(next ? 'signup' : 'login');
      tabs[next].focus();
    });
  });
  window.addEventListener('hashchange', () => setMode(location.hash.slice(1)));
  $('alternate-mode').addEventListener('click', () => {
    navigate(mode === 'login' ? 'signup' : 'login');
    tabs[mode === 'login' ? 1 : 0].focus();
  });
  toggle.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(visible));
  });
  const showInfo = (title, description) => {
    $('dialog-title').textContent = title;
    $('dialog-description').textContent = description;
    $('info-dialog').showModal();
  };
  $('forgot-password').addEventListener('click', () => showInfo('A fresh start.', 'Password recovery will be available when authentication is connected. This is a design preview, so no reset email will be sent.'));
  document.querySelectorAll('[data-provider]').forEach((button) => button.addEventListener('click', () => showInfo('Continue with ' + button.dataset.provider, button.dataset.provider + ' sign-in is part of this design preview. No external account is connected and no details are sent.')));
  $('close-dialog').addEventListener('click', () => $('info-dialog').close());
  $('dialog-done').addEventListener('click', () => $('info-dialog').close());
  $('info-dialog').addEventListener('click', (event) => {
    if (event.target === $('info-dialog')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearErrors();
    const errors = [];
    $('email').value = $('email').value.trim();
    $('full-name').value = $('full-name').value.trim();
    if (mode === 'signup' && !$('full-name').value) errors.push(['full-name', 'name-error', 'Please enter your full name.']);
    if (!$('email').value) errors.push(['email', 'email-error', 'Please enter your email address.']);
    else if (!$('email').validity.valid) errors.push(['email', 'email-error', 'Enter a valid email address, such as alex@example.com.']);
    if (!password.value) errors.push(['password', 'password-error', 'Please enter your password.']);
    else if (mode === 'signup' && password.value.length < 8) errors.push(['password', 'password-error', 'Your password needs at least 8 characters.']);
    if (errors.length) {
      errors.forEach(([field, error, message]) => { $(field).setAttribute('aria-invalid', 'true'); $(error).textContent = message; });
      $(errors[0][0]).focus();
      return;
    }
    $('form-status').hidden = false;
    $('form-status').textContent = mode === 'signup' ? 'You’re all set for the preview. No account was created and no details were saved.' : 'Looking good! This is a preview, so you haven’t been signed in and no details were saved.';
    password.value = '';
    password.type = 'password';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
  });
  setMode(location.hash.slice(1));
})();
