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
const authSendBtnEl = document.getElementById('authSendBtn');
const authTogglePasswordBtnEl = document.getElementById('authTogglePasswordBtn');
const authStatusEl = document.getElementById('authStatus');
const signOutBtnEl = document.getElementById('signOutBtn');

let usePasswordMode = false;

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

if(authSendBtnEl){
  authSendBtnEl.onclick = async () => {
    const email = (authEmailEl.value || '').trim();
    if(!email){ authStatusEl.textContent = 'Enter your email first.'; return; }

    if(usePasswordMode){
      const password = authPasswordEl ? authPasswordEl.value : '';
      if(!password){ authStatusEl.textContent = 'Enter your password.'; return; }
      authSendBtnEl.disabled = true;
      authStatusEl.textContent = 'Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email, password });
      authSendBtnEl.disabled = false;
      authStatusEl.textContent = error ? 'Wrong email or password.' : '';
      return;
    }

    authSendBtnEl.disabled = true;
    authStatusEl.textContent = 'Sending…';
    const { error } = await sb.auth.signInWithOtp({
      email,
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
