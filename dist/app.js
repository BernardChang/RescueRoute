(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('auth-form');
  const tabs = [$('login-tab'), $('signup-tab')];
  const password = $('password');
  const toggle = document.querySelector('.password-toggle');
  let mode = 'login';
  let firebase;
  let ready = false;
  let pending = false;
  let resetPending = false;
  let initializationError = '';

  function message(element, text, isError = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('is-error', isError);
  }
  function clearErrors() {
    form.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((element) => element.removeAttribute('aria-invalid'));
    message($('form-status'), '');
  }
  function concealPassword() {
    password.type = 'password';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
  }
  function updateControls(label) {
    const disabled = pending || !ready;
    form.querySelectorAll('input, button').forEach((element) => { element.disabled = disabled; });
    $('full-name').disabled = disabled || mode !== 'signup';
    tabs.forEach((tab) => { tab.disabled = pending; });
    $('alternate-mode').disabled = pending;
    $('signout-button').disabled = disabled;
    $('reset-submit').disabled = disabled || resetPending;
    form.setAttribute('aria-busy', String(pending));
    $('submit-button').textContent = label || (!ready && !initializationError ? 'Connecting…' : mode === 'signup' ? 'Create account' : 'Log in');
  }
  function setMode(nextMode) {
    if (pending) return;
    mode = nextMode === 'signup' ? 'signup' : 'login';
    const signup = mode === 'signup';
    document.body.classList.toggle('signup', signup && !firebase?.auth.currentUser);
    document.querySelectorAll('.signup-only').forEach((element) => { element.hidden = !signup; });
    document.querySelectorAll('.login-only').forEach((element) => { element.hidden = signup; });
    $('full-name').required = signup;
    tabs.forEach((tab, index) => {
      const active = index === (signup ? 1 : 0);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('auth-panel').setAttribute('aria-labelledby', signup ? 'signup-tab' : 'login-tab');
    $('form-heading').textContent = signup ? 'Your next chapter.' : 'Welcome back.';
    $('form-description').textContent = signup ? 'Create your account and make yourself at home.' : 'Good to see you again. Let’s pick up where you left off.';
    $('mode-prompt-copy').textContent = signup ? 'Already part of Vertex?' : 'New to Vertex?';
    $('alternate-mode').textContent = signup ? 'Log in' : 'Create an account';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    password.placeholder = signup ? 'Create a password' : 'Enter your password';
    password.value = '';
    concealPassword();
    document.title = signup ? 'Create your account · Vertex' : 'Welcome back · Vertex';
    clearErrors();
    if (initializationError) message($('form-status'), initializationError, true);
    updateControls();
  }
  function showAccount() {
    homeView.hidden = true;
    $('uploads-page').hidden = true;
    document.body.classList.add('account-open');
    document.querySelector('.auth-shell').style.display = 'grid';
    if (!['#login', '#signup'].includes(location.hash)) history.pushState(null, '', '#login');
    setMode(location.hash === '#signup' ? 'signup' : 'login');
  }
  const homeView = $('rescue-home');
  window.addEventListener('rescue:account', showAccount);
  window.addEventListener('rescue:map', () => {
    document.body.classList.remove('account-open');
    document.querySelector('.auth-shell').style.display = 'none';
    homeView.hidden = false;
    $('uploads-page').hidden = true;
    if (location.hash !== '#map') history.pushState(null, '', '#map');
  });
  function navigate(nextMode) {
    if (pending) return;
    setMode(nextMode);
    if (location.hash !== '#' + mode) history.pushState(null, '', '#' + mode);
  }
  function renderUser(user) {
    $('auth-view').hidden = !!user;
    $('account-view').hidden = !user;
    document.body.classList.toggle('signed-in', !!user);
    document.body.classList.toggle('signup', !user && mode === 'signup');
    document.querySelector('.form-panel').setAttribute('aria-labelledby', user ? 'account-heading' : 'form-heading');
    $('account-name').textContent = user?.displayName || 'Your Vertex account';
    $('account-email').textContent = user?.email || '';
    if (user) {
      password.value = '';
      concealPassword();
      document.title = 'Your account · Vertex';
    } else {
      document.title = mode === 'signup' ? 'Create your account · Vertex' : 'Welcome back · Vertex';
      message($('account-status'), '');
    }
  }
  function friendlyError(error) {
    const messages = {
      'auth/invalid-credential': 'The email or password is incorrect. Please try again.',
      'auth/invalid-login-credentials': 'The email or password is incorrect. Please try again.',
      'auth/wrong-password': 'The email or password is incorrect. Please try again.',
      'auth/user-not-found': 'The email or password is incorrect. Please try again.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/email-already-in-use': 'An account already uses this email. Log in or reset your password.',
      'auth/weak-password': 'Choose a stronger password with at least 8 characters.',
      'auth/password-does-not-meet-requirements': 'Your password does not meet the account requirements. Please choose a stronger password.',
      'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
      'auth/network-request-failed': 'We couldn’t connect. Check your internet connection and try again.',
      'auth/user-disabled': 'This account is unavailable. Please contact support.',
      'auth/operation-not-allowed': 'Email sign-in is currently unavailable. Please try again later.',
      'auth/web-storage-unsupported': 'Your browser is blocking sign-in storage. Allow site storage and try again.',
      'auth/unauthorized-domain': 'Sign-in is unavailable on this website address.',
    };
    return messages[error?.code] || 'We couldn’t complete that request. Please try again.';
  }
  function fieldError(field, errorId, text) {
    $(field).setAttribute('aria-invalid', 'true');
    $(errorId).textContent = text;
  }
  function passwordPolicyMessage(policy) {
    const missing = [];
    if (policy.meetsMinPasswordLength === false) missing.push(`at least ${policy.passwordPolicy.customStrengthOptions.minPasswordLength} characters`);
    if (policy.meetsMaxPasswordLength === false) missing.push(`no more than ${policy.passwordPolicy.customStrengthOptions.maxPasswordLength} characters`);
    if (policy.containsLowercaseLetter === false) missing.push('a lowercase letter');
    if (policy.containsUppercaseLetter === false) missing.push('an uppercase letter');
    if (policy.containsNumericCharacter === false) missing.push('a number');
    if (policy.containsNonAlphanumericCharacter === false) missing.push('a symbol');
    return missing.length ? 'Use ' + missing.join(', ') + '.' : 'Choose a password that meets your account’s password requirements.';
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => navigate(index ? 'signup' : 'login'));
    tab.addEventListener('keydown', (event) => {
      if (pending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      navigate(next ? 'signup' : 'login');
      tabs[next].focus();
    });
  });
  const syncLocation = () => {
    if (location.hash === '#map' || !location.hash) {
      document.body.classList.remove('account-open');
      homeView.hidden = false;
      document.querySelector('.auth-shell').style.display = 'none';
      return;
    }
    if (location.hash === '#login' || location.hash === '#signup') {
      document.body.classList.add('account-open');
      homeView.hidden = true;
      document.querySelector('.auth-shell').style.display = 'grid';
    }
    const nextMode = location.hash === '#signup' ? 'signup' : 'login';
    if (nextMode !== mode) setMode(nextMode);
  };
  window.addEventListener('hashchange', syncLocation);
  window.addEventListener('popstate', syncLocation);
  $('alternate-mode').addEventListener('click', () => {
    navigate(mode === 'login' ? 'signup' : 'login');
    tabs[mode === 'signup' ? 1 : 0].focus();
  });
  toggle.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(visible));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || pending) return;
    clearErrors();
    const signup = mode === 'signup';
    const email = $('email').value.trim();
    const name = $('full-name').value.trim();
    const enteredPassword = password.value;
    $('email').value = email;
    $('full-name').value = name;
    const errors = [];
    if (signup && !name) errors.push(['full-name', 'name-error', 'Please enter your full name.']);
    if (!email) errors.push(['email', 'email-error', 'Please enter your email address.']);
    else if (!$('email').validity.valid) errors.push(['email', 'email-error', 'Enter a valid email address, such as alex@example.com.']);
    if (!enteredPassword) errors.push(['password', 'password-error', 'Please enter your password.']);
    else if (signup && enteredPassword.length < 8) errors.push(['password', 'password-error', 'Your password needs at least 8 characters.']);
    if (errors.length) {
      errors.forEach((error) => fieldError(...error));
      $(errors[0][0]).focus();
      return;
    }
    pending = true;
    updateControls(signup ? 'Creating account…' : 'Logging in…');
    let signedIn = false;
    let completedUserId = null;
    let invalidPassword = false;
    try {
      if (signup) {
        const policy = await firebase.validatePassword(firebase.auth, enteredPassword);
        if (!policy.isValid) {
          fieldError('password', 'password-error', passwordPolicyMessage(policy));
          invalidPassword = true;
          return;
        }
      }
      await firebase.setPersistence(firebase.auth, $('remember').checked ? firebase.browserLocalPersistence : firebase.browserSessionPersistence);
      const credential = signup
        ? await firebase.createUserWithEmailAndPassword(firebase.auth, email, enteredPassword)
        : await firebase.signInWithEmailAndPassword(firebase.auth, email, enteredPassword);
      signedIn = true;
      completedUserId = credential.user.uid;
      let profileFailed = false;
      if (signup) {
        try {
          await firebase.updateProfile(credential.user, { displayName: name });
        } catch {
          // Account creation succeeded; never turn a profile failure into a second signup.
          profileFailed = true;
        }
      }
      renderUser(firebase.auth.currentUser);
      if (firebase.auth.currentUser?.uid === completedUserId) {
        message($('account-status'), profileFailed
          ? 'Your account is ready, but your name couldn’t be saved. You are still signed in.'
          : signup ? 'Your account has been created.' : '', profileFailed);
      }
    } catch (error) {
      message($('form-status'), friendlyError(error), true);
    } finally {
      pending = false;
      updateControls();
      // Reconcile changes from other tabs that arrived during this operation.
      renderUser(firebase.auth.currentUser);
      if (signedIn && firebase.auth.currentUser?.uid === completedUserId) $('account-heading').focus();
      else if (signedIn && !firebase.auth.currentUser) message($('form-status'), 'Your session changed. Please log in again.');
      if (invalidPassword) password.focus();
    }
  });

  $('signout-button').addEventListener('click', async () => {
    if (!ready || pending) return;
    pending = true;
    updateControls();
    $('signout-button').textContent = 'Logging out…';
    try {
      await firebase.signOut(firebase.auth);
      pending = false;
      navigate('login');
      form.reset();
      renderUser(null);
      message($('form-status'), 'You’ve been logged out.');
      $('email').focus();
    } catch (error) {
      message($('account-status'), friendlyError(error), true);
    } finally {
      pending = false;
      $('signout-button').textContent = 'Log out';
      updateControls();
      renderUser(firebase.auth.currentUser);
    }
  });

  $('forgot-password').addEventListener('click', () => {
    if (!ready || pending || resetPending) return;
    $('reset-form').reset();
    $('reset-email').value = $('email').value.trim();
    $('reset-email').removeAttribute('aria-invalid');
    $('reset-error').textContent = '';
    message($('reset-status'), '');
    $('reset-dialog').showModal();
    $('reset-email').focus();
  });
  $('close-reset').addEventListener('click', () => $('reset-dialog').close());
  $('reset-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || resetPending) return;
    const input = $('reset-email');
    input.value = input.value.trim();
    input.removeAttribute('aria-invalid');
    $('reset-error').textContent = '';
    message($('reset-status'), '');
    if (!input.value || !input.validity.valid) {
      input.setAttribute('aria-invalid', 'true');
      $('reset-error').textContent = 'Please enter a valid email address.';
      input.focus();
      return;
    }
    resetPending = true;
    input.disabled = true;
    $('reset-submit').disabled = true;
    $('reset-submit').textContent = 'Sending…';
    try {
      await firebase.sendPasswordResetEmail(firebase.auth, input.value);
      message($('reset-status'), 'If an account exists for this email, a password reset link will arrive shortly. Check your inbox and spam folder.');
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        message($('reset-status'), 'If an account exists for this email, a password reset link will arrive shortly. Check your inbox and spam folder.');
      } else {
        message($('reset-status'), friendlyError(error), true);
      }
    } finally {
      resetPending = false;
      input.disabled = false;
      $('reset-submit').textContent = 'Send reset link';
      updateControls();
    }
  });

  const initialRoute = location.hash.slice(1);
  if (initialRoute === 'login' || initialRoute === 'signup') {
    document.body.classList.add('account-open');
    homeView.hidden = true;
    document.querySelector('.auth-shell').style.display = 'grid';
  }
  setMode(initialRoute);
  // Catch module/network failures so visitors get a useful error instead of an inert form.
  import('./firebase-client.js').then(async (client) => {
    firebase = client;
    await firebase.auth.authStateReady();
    ready = true;
    updateControls();
    firebase.onAuthStateChanged(firebase.auth, (user) => {
      if (!pending) renderUser(user);
    }, () => {
      message($('form-status'), 'We couldn’t check your session. Please reload and try again.', true);
    });
  }).catch(() => {
    initializationError = 'We couldn’t connect to sign-in. Check your connection and reload this page.';
    message($('form-status'), initializationError, true);
    updateControls();
  });
})();
