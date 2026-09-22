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
// Set right before any of the three actions that actually complete a sign-
// in (password, signup, code verify — signInWithOtp itself only sends the
// code, it doesn't sign anyone in) and read once by handleSignedIn, so it
// can tell a real sign-in apart from onAuthStateChange firing for a plain
// page refresh restoring an existing session — those otherwise look
// identical by the time that callback runs. Reintroduced after a brief
// removal: without this distinction, a plain refresh mid-task landed back
// on Snap too, which is its own bug — see handleSignedIn's own comment.
let expectFreshSignIn = false;

function showApp(){
  // The email/password/code field just used to sign in can still hold
  // focus at this point — hiding its container via display:none usually
  // blurs it, but on at least one mobile browser that blur (and the
  // keyboard-close animation it triggers) landed late enough to still be
  // in flight when the scroll-to-top below ran, dragging the page back
  // down again after it. Blurring explicitly, before any of that, means
  // there's nothing left with focus for a delayed native scroll-into-view
  // to act on.
  if(document.activeElement && typeof document.activeElement.blur === 'function'){
    const active = document.activeElement;
    if(active === authEmailEl || active === authPasswordEl || active === authCodeEl) active.blur();
  }
  if(authScreenEl) authScreenEl.style.display = 'none';
  if(appEl) appEl.style.display = '';
  if(bottomTabsEl) bottomTabsEl.style.display = '';
  if(signOutBtnEl) signOutBtnEl.style.display = '';
  // The bar was just unhidden (was display:none, so had no real size to
  // measure until now) — see syncBottomTabsClearance (app.js).
  if(typeof syncBottomTabsClearance === 'function') syncBottomTabsClearance();
}

// Forcing the scroll position back to 0 at one or two guessed moments
// (right after sign-in, after loadState() repopulates the page, after a
// fixed delay for the keyboard-close animation) never actually fixed this
// on Chrome for iOS — confirmed by hand that scrollTo(0,0) alone, however
// many times it's called, does nothing there. The tell was a real user
// swipe fixing it instantly, by even a single pixel: window.scrollY was
// most likely already reading 0 the whole time, with the page genuinely
// painted a few pixels off anyway — swapping the short auth screen for the
// real, tall app content leaves Chrome's own toolbar/viewport compositing
// stale until something forces it to recompute, and a scrollTo call that
// doesn't actually move scrollY (because it already reads 0) doesn't
// count as that something. A real swipe does. This forces the same real
// movement in code — away from 0, then back — rather than only asserting
// the end position, on every frame for durationMs so it also outlasts
// whatever later, variable-timed thing (keyboard animation, autofill
// prompt, Chrome's own restore) might re-assert a stale offset afterward.
// Self-terminating, and only ever runs for this one, brief window right
// after a genuine sign-in — never a plain refresh or tab switch, where a
// real scroll position is exactly what should be left alone.
function lockScrollToTop(durationMs){
  const until = Date.now() + durationMs;
  function tick(){
    window.scrollTo(0, 1);
    window.scrollTo(0, 0);
    if(Date.now() < until) requestAnimationFrame(tick);
  }
  tick();
}

function showAuthScreen(){
  if(appEl) appEl.style.display = 'none';
  if(bottomTabsEl) bottomTabsEl.style.display = 'none';
  if(signOutBtnEl) signOutBtnEl.style.display = 'none';
  if(authScreenEl) authScreenEl.style.display = '';
}

async function handleSignedIn(user, isFreshSignIn){
  // onAuthStateChange and the initial getSession() check can both fire for
  // the same session — guard against loading everything twice.
  if(currentUser && currentUser.id === user.id){ showApp(); return; }
  currentUser = user;
  // Only an actual sign-in resets this to Data — a session that had ended
  // on some other tab (Profile included) shouldn't reopen there right
  // after signing back in, and a plain page refresh mid-task (e.g.
  // Collection) shouldn't dump you back on Snap either. A plain refresh is
  // a *different* case (isFreshSignIn is false for it, see the two call
  // sites below): it restores whatever tab was last active instead (see
  // the activeTab declaration in app.js).
  if(isFreshSignIn){
    activeTab = 'data';
    try{ localStorage.setItem('timekeeper-active-tab', 'data'); }catch(e){}
  }
  // The scroll lock itself used to be gated on isFreshSignIn too, on the
  // assumption that scrollRestoration:'manual' (index.html) alone was
  // enough for the other path here — sb.auth.getSession()'s own call below,
  // which covers a mobile browser simply reopening an already-signed-in
  // tab, never a real sign-in tap. That assumption doesn't hold on Chrome
  // for iOS: scrollRestoration:'manual' is a standard History API setting,
  // and Chrome's own tab-resume mechanism on iOS isn't necessarily built on
  // that API at all, so it can restore a stale scroll position regardless
  // of it. Since this whole block only runs once per real transition from
  // signed-out (or first load) to signed-in — the guard just above already
  // short-circuits a token refresh or duplicate event for a user already
  // showing — running this unconditionally here can't fire on every scroll
  // or every re-render, only on that one transition, fresh sign-in or not.
  window.scrollTo(0, 0);
  lockScrollToTop(2000);
  // The bottom bar lives outside #root (see syncBottomTabs in app.js), so
  // just changing activeTab here doesn't move its highlight — without this,
  // signing back in right after signing out from some other tab left the
  // bar still lit up on that old tab while the content underneath had
  // already switched to Data.
  if(typeof syncBottomTabs === 'function') syncBottomTabs();
  // The account's own saved theme (see js/profile.js) wins over whatever
  // was showing pre-login — that matters specifically when signing in on
  // a browser/device that never had this account's choice saved locally
  // before. No account-level value yet just means "nothing to change".
  const accountTheme = user.user_metadata && user.user_metadata.theme;
  if(accountTheme && typeof applyTheme === 'function'){
    try{ localStorage.setItem('timekeeper-theme', accountTheme); }catch(e){}
    applyTheme(accountTheme);
  }
  // Same idea for the Clock tab's Show date/Show GMT toggles and the GMT
  // offset (clock.js) — written to the account by syncClockPrefToAccount
  // whenever one of those changes, read back here the same way theme is
  // above. Checked for undefined rather than truthiness: an account that
  // has explicitly turned a toggle off still needs that false applied, not
  // skipped as if nothing were saved — undefined is the only real "nothing
  // saved yet for this account" case.
  const meta = user.user_metadata || {};
  if(meta.clock_show_date !== undefined){
    showClockDate = !!meta.clock_show_date;
    try{ localStorage.setItem('timekeeper-clock-date', showClockDate ? '1' : '0'); }catch(e){}
  }
  if(meta.clock_show_gmt !== undefined){
    showClockGmt = !!meta.clock_show_gmt;
    try{ localStorage.setItem('timekeeper-clock-gmt', showClockGmt ? '1' : '0'); }catch(e){}
  }
  if(meta.clock_gmt_offset_minutes !== undefined){
    clockGmtOffsetMinutes = Number(meta.clock_gmt_offset_minutes) || 0;
    try{ localStorage.setItem('timekeeper-clock-gmt-offset', String(clockGmtOffsetMinutes)); }catch(e){}
  }
  if(meta.clock_timezone_offset_minutes !== undefined){
    clockTimezoneOffsetMinutes = meta.clock_timezone_offset_minutes === null ? null : Number(meta.clock_timezone_offset_minutes);
    try{
      if(clockTimezoneOffsetMinutes === null) localStorage.removeItem('timekeeper-clock-timezone-offset');
      else localStorage.setItem('timekeeper-clock-timezone-offset', String(clockTimezoneOffsetMinutes));
    }catch(e){}
  }
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
  // Reset here too, not just on the next sign-in (handleSignedIn's own
  // isFreshSignIn check, above) — signing out from Profile and straight
  // back in could still land back on Profile, since Supabase doesn't
  // always fire a distinct SIGNED_IN event for that same-tab round trip
  // the way expectFreshSignIn expects. Resetting the moment you sign out
  // means the next sign-in lands on Data regardless of whether it's
  // recognized as "fresh" or just restores what's already saved here.
  activeTab = 'data';
  try{ localStorage.setItem('timekeeper-active-tab', 'data'); }catch(e){}
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
      if(!error) expectFreshSignIn = true;
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
      expectFreshSignIn = true;
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
      if(!error) expectFreshSignIn = true;
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
    // Consumed once, immediately — this event also fires for a token
    // refresh or (in some SDK versions) the initial session restore
    // itself, and expectFreshSignIn must never carry over to one of those.
    handleSignedIn(session.user, expectFreshSignIn);
    expectFreshSignIn = false;
  } else {
    handleSignedOut();
  }
});

// Covers the very first load, before onAuthStateChange's initial event
// fires — never a fresh sign-in itself, just this tab noticing a session
// that (per Supabase's own storage) already existed before it opened.
sb.auth.getSession().then(({ data }) => {
  if(data && data.session && data.session.user){
    handleSignedIn(data.session.user, false);
  } else {
    showAuthScreen();
  }
});
