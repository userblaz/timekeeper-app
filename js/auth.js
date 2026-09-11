// Supabase client + authentication. Gates the whole app behind a signed-in
// session — data.js never talks to Supabase until currentUser is set here.
// Loaded LAST on purpose, same reasoning as app.js: everything it calls
// (loadState, syncTrueTime, render) must already be defined.

const SUPABASE_URL = 'https://sijqzjobdkxfuszgvtts.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpanF6am9iZGt4ZnVzemd2dHRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5ODQ2MTksImV4cCI6MjEwNDU2MDYxOX0.HJVpfAmndN1oxMeHP2PGEgeKuPg5QxC9Rctju-JXlo8';

// Named `sb`, not `supabase` — the CDN script already put its own library
// namespace on `window.supabase`, so reusing that name here would shadow it.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;

const authScreenEl = document.getElementById('authScreen');
const appEl = document.getElementById('app');
const bottomTabsEl = document.getElementById('bottomTabs');
const authEmailEl = document.getElementById('authEmail');
const authPasswordFieldEl = document.getElementById('authPasswordField');
const authPasswordEl = document.getElementById('authPassword');
const authCodeFieldEl = document.getElementById('authCodeField');
const authCodeEl = document.getElementById('authCode');
const authSendBtnEl = document.getElementById('authSendBtn');
const authToggleSignupBtnEl = document.getElementById('authToggleSignupBtn');
const authToggleCodeBtnEl = document.getElementById('authToggleCodeBtn');
const authBackBtnEl = document.getElementById('authBackBtn');
const authStatusEl = document.getElementById('authStatus');
const signOutBtnEl = document.getElementById('signOutBtn');

// authMode: 'signin' | 'signup' | 'code-request' | 'code-verify'.
// One state machine instead of separate toggle flags — every field's
// visibility and the button's label are derived from this one value.
let authMode = 'signin';
let codeSentToEmail = ''; // locked in once a code is sent, so editing the
// email field mid-verify can't send the code to one address and verify
// against another.

function showApp(){
  if(authScreenEl) authScreenEl.style.display = 'none';
  if(appEl) appEl.style.display = '';
  if(bottomTabsEl) bottomTabsEl.style.display = '';
  if(signOutBtnEl) signOutBtnEl.style.display = '';
}

function showAuthScreen(){
  if(appEl) appEl.style.display = 'none';
  if(bottomTabsEl) bottomTabsEl.style.display = 'none';
  if(signOutBtnEl) signOutBtnEl.style.display = 'none';
  if(authScreenEl) authScreenEl.style.display = '';
}

async function handleSignedIn(user){
  // onAuthStateChange and the initial getSession() check can both fire for
  // the same session — guard against loading everything twice.
  if(currentUser && currentUser.id === user.id){ showApp(); return; }
  currentUser = user;
  showApp();
  await loadState();
  syncTrueTime();
  setInterval(syncTrueTime, 5 * 60 * 1000);
}

function handleSignedOut(){
  currentUser = null;
  state.watches = [];
  state.activeId = null;
  loaded = false;
  showAuthScreen();
}

function renderAuthMode(){
  const isPasswordStep = authMode === 'signin' || authMode === 'signup';
  const isCodeVerify = authMode === 'code-verify';

  if(authPasswordFieldEl) authPasswordFieldEl.style.display = isPasswordStep ? '' : 'none';
  if(authCodeFieldEl) authCodeFieldEl.style.display = isCodeVerify ? '' : 'none';
  if(authToggleSignupBtnEl) authToggleSignupBtnEl.style.display = isPasswordStep ? '' : 'none';
  if(authToggleCodeBtnEl) authToggleCodeBtnEl.style.display = authMode === 'signin' ? '' : 'none';
  if(authBackBtnEl) authBackBtnEl.style.display = (authMode === 'code-request' || isCodeVerify) ? '' : 'none';
  if(authEmailEl) authEmailEl.disabled = isCodeVerify;

  if(authToggleSignupBtnEl){
    authToggleSignupBtnEl.textContent = authMode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account';
  }
  if(authSendBtnEl){
    authSendBtnEl.textContent =
      authMode === 'signin' ? 'Sign in' :
      authMode === 'signup' ? 'Create account' :
      authMode === 'code-request' ? 'Send code' : 'Verify code';
  }
  authStatusEl.textContent = '';
}

function setAuthMode(mode){
  authMode = mode;
  renderAuthMode();
}

if(authSendBtnEl){
  authSendBtnEl.onclick = async () => {
    const email = (authEmailEl.value || '').trim();
    if(authMode !== 'code-verify' && !email){ authStatusEl.textContent = 'Enter your email first.'; return; }

    if(authMode === 'signin'){
      const password = authPasswordEl ? authPasswordEl.value : '';
      if(!password){ authStatusEl.textContent = 'Enter your password.'; return; }
      authSendBtnEl.disabled = true;
      authStatusEl.textContent = 'Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email, password });
      authSendBtnEl.disabled = false;
      authStatusEl.textContent = error ? 'Wrong email or password.' : '';
      return;
    }

    if(authMode === 'signup'){
      const password = authPasswordEl ? authPasswordEl.value : '';
      if(!password){ authStatusEl.textContent = 'Enter your password.'; return; }
      authSendBtnEl.disabled = true;
      authStatusEl.textContent = 'Creating account…';
      const { data, error } = await sb.auth.signUp({ email, password });
      authSendBtnEl.disabled = false;
      if(error){ authStatusEl.textContent = error.message; return; }
      if(!data.session){
        // "Confirm email" is still on in Supabase settings — account was
        // created but needs the emailed link clicked before it can sign in.
        // This is the ONLY place email confirmation happens — signing in
        // afterwards, in any browser, never asks for it again.
        authStatusEl.textContent = 'Account created — check your email to confirm it, then sign in.';
        return;
      }
      authStatusEl.textContent = ''; // onAuthStateChange takes it from here
      return;
    }

    if(authMode === 'code-request'){
      authSendBtnEl.disabled = true;
      authStatusEl.textContent = 'Sending code…';
      // Same call as before, but we now verify the 6-digit code Supabase
      // includes in that email instead of relying on the clickable link —
      // that's what lets this finish in the same browser tab.
      const { error } = await sb.auth.signInWithOtp({ email });
      authSendBtnEl.disabled = false;
      if(error){ authStatusEl.textContent = 'Something went wrong — try again.'; return; }
      codeSentToEmail = email;
      setAuthMode('code-verify');
      authStatusEl.textContent = 'Enter the 6-digit code we just emailed you.';
      return;
    }

    if(authMode === 'code-verify'){
      const code = (authCodeEl ? authCodeEl.value : '').trim();
      if(!code){ authStatusEl.textContent = 'Enter the code from your email.'; return; }
      authSendBtnEl.disabled = true;
      authStatusEl.textContent = 'Verifying…';
      const { error } = await sb.auth.verifyOtp({ email: codeSentToEmail, token: code, type: 'email' });
      authSendBtnEl.disabled = false;
      authStatusEl.textContent = error ? 'Wrong or expired code — try again.' : '';
      return;
    }
  };
}

if(authEmailEl){
  authEmailEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); if(authSendBtnEl) authSendBtnEl.click(); }
  });
}

if(authPasswordEl){
  authPasswordEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); if(authSendBtnEl) authSendBtnEl.click(); }
  });
}

if(authCodeEl){
  authCodeEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); if(authSendBtnEl) authSendBtnEl.click(); }
  });
}

if(authToggleSignupBtnEl){
  authToggleSignupBtnEl.onclick = () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
}

if(authToggleCodeBtnEl){
  authToggleCodeBtnEl.onclick = () => setAuthMode('code-request');
}

if(authBackBtnEl){
  authBackBtnEl.onclick = () => setAuthMode('signin');
}

if(signOutBtnEl){
  signOutBtnEl.onclick = async () => {
    await sb.auth.signOut();
  };
}

sb.auth.onAuthStateChange((event, session) => {
  if(session && session.user){
    handleSignedIn(session.user);
  } else {
    handleSignedOut();
  }
});

// Covers the very first load, before onAuthStateChange's initial event fires.
sb.auth.getSession().then(({ data }) => {
  if(data && data.session && data.session.user){
    handleSignedIn(data.session.user);
  } else {
    showAuthScreen();
  }
});
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    authSendBtnEl.disabled = false;
    authStatusEl.textContent = error
      ? ('Something went wrong — try again.')
      : 'Check your email for the sign-in link.';
  };
}

if(authTogglePasswordBtnEl){
  authTogglePasswordBtnEl.onclick = () => {
    usePasswordMode = !usePasswordMode;
    if(authPasswordFieldEl) authPasswordFieldEl.style.display = usePasswordMode ? '' : 'none';
    authSendBtnEl.textContent = usePasswordMode ? 'Sign in' : 'Send magic link';
    authTogglePasswordBtnEl.textContent = usePasswordMode ? 'Use magic link instead' : 'Use a password instead';
    authStatusEl.textContent = '';
  };
}

if(authPasswordEl){
  authPasswordEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); if(authSendBtnEl) authSendBtnEl.click(); }
  });
}

if(authEmailEl){
  authEmailEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); if(authSendBtnEl) authSendBtnEl.click(); }
  });
}

if(signOutBtnEl){
  signOutBtnEl.onclick = async () => {
    await sb.auth.signOut();
  };
}

sb.auth.onAuthStateChange((event, session) => {
  if(session && session.user){
    handleSignedIn(session.user);
  } else {
    handleSignedOut();
  }
});

// Covers the very first load, before onAuthStateChange's initial event fires.
sb.auth.getSession().then(({ data }) => {
  if(data && data.session && data.session.user){
    handleSignedIn(data.session.user);
  } else {
    showAuthScreen();
  }
});
