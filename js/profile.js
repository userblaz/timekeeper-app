// Profile tab — account settings, FAQ, and app info. Behaves as a normal
// tab now (participates in app.js's existing activeTab/render() system,
// same as Data/Clock/Collection), reached from its own bottom-tab button
// rather than a separate overlay — the bottom bar stays visible and
// switching to another tab is how you "leave" it, no back button needed.
//
// Still independent of auth.js for visibility: shown/hidden off Supabase's
// own auth events rather than auth.js's showApp()/showAuthScreen(), so
// that file never needed to change for any of this.
//
// To remove this feature entirely: delete this file, its <script> tag in
// index.html, the #profileBtn button there, and the "activeTab==='profile'"
// block in app.js's render(). Nothing else references any of it.

const profileBtnEl = document.getElementById('profileBtn');

// 'menu' | 'account' | 'faq' | 'info' — sub-navigation *within* the tab.
// The top-level 'menu' view has no back button (the bottom bar is how you
// navigate away); the three sub-views still need a small way back to the
// menu, since those aren't reachable from the bottom bar directly.
let profileView = 'menu';
let profileLastActiveTab = null;

// Theme: persisted in localStorage (a display preference, not account
// data) and applied by setting a data attribute on <html> — every color
// in the app is already a CSS variable keyed off that attribute (see
// styles.css), so nothing else needs to know a theme switch happened.
// The very first application, before this file even loads, happens via a
// small inline script in index.html's <head> — this is just where the
// toggle itself lives and where later changes get applied live.
function getSavedTheme(){
  try{
    const saved = localStorage.getItem('timekeeper-theme');
    if(saved !== null) return saved;
    // Nothing saved yet — same system-preference fallback as the inline
    // script in index.html's <head>, so the toggle's initial position
    // always matches whatever was actually applied on load.
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }catch(e){ return 'dark'; }
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  const themeColorEl = document.querySelector('meta[name="theme-color"]');
  if(themeColorEl) themeColorEl.setAttribute('content', theme === 'light' ? '#F7F7FA' : '#14141C');
}
// The one place a theme change actually gets saved from — applies it
// instantly, remembers it locally for the very next page load (before any
// account data is available), and syncs it to the account itself so it's
// not just this one browser that remembers it. A theme picked up from the
// account on sign-in (see auth.js) calls applyTheme() directly instead of
// this, since there's nothing to sync back in that direction.
function saveThemePreference(theme){
  try{ localStorage.setItem('timekeeper-theme', theme); }catch(e){}
  applyTheme(theme);
  if(currentUser){
    sb.auth.updateUser({ data: { ...(currentUser.user_metadata || {}), theme } })
      .then(({ data, error }) => { if(!error && data && data.user) currentUser = data.user; });
  }
} // used only to detect "just switched into
// this tab from elsewhere", so arriving fresh always starts at the menu,
// while navigating between its own sub-views (which also calls render())
// doesn't get reset out from under itself.

function buildProfileTabHtml(){
  if(profileLastActiveTab !== 'profile') profileView = 'menu';
  profileLastActiveTab = activeTab;

  if(profileView === 'account') return buildAccountViewHtml();
  if(profileView === 'faq') return buildFaqViewHtml();
  if(profileView === 'info') return buildInfoViewHtml();
  return buildMenuViewHtml();
}

function buildMenuViewHtml(){
  // Nothing to say when idle — the status line only appears while a save is
  // in flight, has failed, or a backup was just exported.
  const statusText = saveStatus === 'saving' ? 'saving…'
    : saveStatus === 'error' ? 'save failed — storage may be full or blocked'
    : lastExportAt ? 'backed up ' + lastExportAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    : '';
  return `
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
      <h2 class="section-title profile-centered-title">Profile</h2>
      <div class="profile-menu-list">
        <div class="profile-theme-row">
          <span id="profileThemeLabel">${getSavedTheme() === 'light' ? 'Light mode' : 'Dark mode'}</span>
          <label class="profile-switch">
            <input type="checkbox" id="profileThemeToggle" ${getSavedTheme() === 'light' ? 'checked' : ''} />
            <span class="profile-switch-track"><span class="profile-switch-thumb"></span></span>
          </label>
        </div>
        <button type="button" class="profile-menu-item" data-action="profilenav" data-view="account">
          <span>Account settings</span><span class="profile-menu-chevron">›</span>
        </button>
        <button type="button" class="profile-menu-item" data-action="profilenav" data-view="faq">
          <span>FAQ</span><span class="profile-menu-chevron">›</span>
        </button>
        <button type="button" class="profile-menu-item" data-action="profilenav" data-view="info">
          <span>About Timekeeper</span><span class="profile-menu-chevron">›</span>
        </button>
      </div>
      <div class="section" style="margin-top:20px;padding-top:16px;">
        <h2 class="section-title" style="font-size:14px;">Backup</h2>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button type="button" class="btn-secondary" data-action="export" style="flex:1;font-size:12px;padding:10px;">Export backup (.json)</button>
          <label class="btn-secondary" style="flex:1;font-size:12px;padding:10px;text-align:center;cursor:pointer;">
            Import backup
            <input type="file" id="importFile" accept="application/json" style="display:none;" />
          </label>
        </div>
        ${statusText ? `<span class="status ${saveStatus==='error'?'err':''}" style="display:block;text-align:center;margin-top:8px;">${statusText}</span>` : ''}
      </div>

      <p class="hint" style="text-align:center;margin-top:18px;">${currentUser ? escapeHtml(currentUser.email || '') : ''}</p>
      <button type="button" class="btn-secondary" id="profileSignOutBtn" style="width:100%;margin-top:6px;">Sign out</button>
    </div>
  `;
}

function buildSubViewShellHtml(title, innerHtml){
  return `
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
      <button type="button" class="zoom-btn profile-back-btn" data-action="profilemenu" aria-label="Back to Profile">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 6 9 12 15 18" />
        </svg>
      </button>
      <h2 class="section-title profile-centered-title" style="margin-top:10px;">${title}</h2>
      ${innerHtml}
    </div>
  `;
}

// Small pencil icon used next to a masked field — clicking it reveals that
// field's edit inputs below, without disturbing the other field.
function profileEditIconBtnHtml(target){
  return `
    <button type="button" class="profile-edit-icon-btn" data-action="profileedittoggle" data-target="${target}" aria-label="Edit">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  `;
}

function buildAccountViewHtml(){
  const meta = (currentUser && currentUser.user_metadata) || {};
  const inner = `
    <div class="profile-subtab-row">
      <button type="button" class="profile-subtab-btn active" data-action="profilesubtab" data-section="login">Login</button>
      <button type="button" class="profile-subtab-btn" data-action="profilesubtab" data-section="personal">Personal information</button>
    </div>

    <div id="profileLoginSection">
      <div class="profile-field-row">
        <div class="profile-field-view">
          <label>Email</label>
          <div class="profile-field-value">${currentUser ? escapeHtml(currentUser.email || '') : ''}</div>
        </div>
        ${profileEditIconBtnHtml('email')}
      </div>
      <div id="profileEmailEdit" class="field" style="display:none;margin-top:10px;">
        <label for="profileNewEmail">New email</label>
        <input type="email" id="profileNewEmail" placeholder="Enter a new email address" autocomplete="email" />
      </div>

      <div class="profile-field-row" style="margin-top:14px;">
        <div class="profile-field-view">
          <label>Password</label>
          <div class="profile-field-value">••••••••</div>
        </div>
        ${profileEditIconBtnHtml('password')}
      </div>
      <div id="profilePasswordEdit" style="display:none;margin-top:10px;">
        <div class="field">
          <label for="profileCurrentPassword">Current password</label>
          <input type="password" id="profileCurrentPassword" placeholder="Required to set a new one" autocomplete="current-password" />
        </div>
        <div class="field" style="margin-top:12px;">
          <label for="profileNewPassword">New password</label>
          <input type="password" id="profileNewPassword" placeholder="At least 6 characters" autocomplete="new-password" />
        </div>
      </div>
    </div>

    <div id="profilePersonalSection" style="display:none;">
      <div class="field">
        <label for="profileFullName">Name (optional)</label>
        <input type="text" id="profileFullName" value="${escapeHtml(meta.full_name || '')}" placeholder="Your name" />
      </div>
      <div class="field" style="margin-top:12px;">
        <label for="profileBirthDate">Date of birth (optional)</label>
        <input type="date" id="profileBirthDate" value="${escapeHtml(meta.birth_date || '')}" />
      </div>
      <div class="field" style="margin-top:12px;">
        <label for="profilePhone">Phone number (optional)</label>
        <input type="tel" id="profilePhone" value="${escapeHtml(meta.phone_number || '')}" placeholder="e.g. +386 40 123 456" />
      </div>
    </div>

    <button type="button" class="btn-primary" id="profileSaveBtn" style="width:100%;margin-top:18px;">Save changes</button>
    <p class="hint" id="profileStatus" style="text-align:center;margin-top:8px;min-height:16px;"></p>
    <button type="button" class="btn-secondary" id="profileSignOutBtn" style="width:100%;margin-top:6px;">Sign out</button>
  `;
  return buildSubViewShellHtml('Account', inner);
}

// Genuinely from what's actually true about the app right now — not
// generic filler, and nothing here promises a feature that doesn't exist.
function buildFaqViewHtml(){
  const items = [
    ['What does "offset" mean?', 'How many seconds fast (+) or slow (−) your watch has drifted since you last set it against correct time — not the daily rate, the running total.'],
    ['What\'s a "reset point"?', 'Mark a reading as a reset when the watch was just set, serviced, or regulated. Drift is then calculated fresh from that point instead of carrying over the old baseline.'],
    ['Why is the Timegrapher inaccurate on my iPhone?', "iOS applies microphone processing that can't be turned off from a web page, which limits accuracy specifically on iPhone. It works better on Android and desktop. This is a platform limit, not a bug."],
    ['How does power reserve tracking work?', 'Tap "wind" when you fully wind a watch — that\'s the only input it needs. Nothing is inferred automatically, since only you know when it was actually wound.'],
    ['Is my data private from other users?', "Yes — every watch and reading is tied to your account and only ever visible to you, enforced by the database itself, not just the app's interface."]
  ];
  const rows = items.map(([q, a]) => `
    <div class="profile-faq-item">
      <div class="profile-faq-q">${escapeHtml(q)}</div>
      <div class="profile-faq-a">${escapeHtml(a)}</div>
    </div>
  `).join('');
  return buildSubViewShellHtml('FAQ', `<div class="profile-faq-list">${rows}</div>`);
}

function buildInfoViewHtml(){
  const inner = `
    <p class="hint" style="font-size:13px;color:var(--ink);line-height:1.5;">
      Timekeeper tracks mechanical watch accuracy over time — offset readings, drift trends, and factory spec comparisons — plus an experimental mic-based timegrapher and a power-reserve tracker for the Collection tab.
    </p>
    <p class="hint" style="margin-top:14px;">Built and maintained by its own users. Feedback and bug reports welcome — just mention them to whoever's working on it next.</p>
  `;
  return buildSubViewShellHtml('About', inner);
}

function attachProfileHandlers(){
  const themeToggleEl = document.getElementById('profileThemeToggle');
  if(themeToggleEl){
    themeToggleEl.onchange = () => {
      const theme = themeToggleEl.checked ? 'light' : 'dark';
      saveThemePreference(theme);
      const labelEl = document.getElementById('profileThemeLabel');
      if(labelEl) labelEl.textContent = theme === 'light' ? 'Light mode' : 'Dark mode';
    };
  }
  document.querySelectorAll('[data-action="profilemenu"]').forEach(el => {
    el.onclick = () => { profileView = 'menu'; render(); };
  });
  const exportBtn = document.querySelector('[data-action="export"]');
  if(exportBtn) exportBtn.onclick = () => exportData();
  const importInput = document.getElementById('importFile');
  if(importInput) importInput.onchange = (e) => {
    const file = e.target.files[0];
    if(file) importData(file);
  };
  document.querySelectorAll('[data-action="profilenav"]').forEach(el => {
    el.onclick = () => { profileView = el.dataset.view; render(); };
  });
  // Switches which section is visible without a full render() — both
  // stay mounted in the DOM the whole time, so anything typed into either
  // one survives flipping back and forth before hitting Save.
  document.querySelectorAll('[data-action="profilesubtab"]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.profile-subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
      const loginSection = document.getElementById('profileLoginSection');
      const personalSection = document.getElementById('profilePersonalSection');
      if(loginSection) loginSection.style.display = btn.dataset.section === 'login' ? '' : 'none';
      if(personalSection) personalSection.style.display = btn.dataset.section === 'personal' ? '' : 'none';
    };
  });
  // Email/password start collapsed to a masked view + a small pencil icon;
  // tapping it reveals just that field's edit inputs, independent of the
  // other one.
  document.querySelectorAll('[data-action="profileedittoggle"]').forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.target === 'email' ? 'profileEmailEdit' : 'profilePasswordEdit';
      const target = document.getElementById(targetId);
      if(!target) return;
      const opening = target.style.display === 'none';
      target.style.display = opening ? '' : 'none';
      btn.classList.toggle('active', opening);
    };
  });

  const saveBtn = document.getElementById('profileSaveBtn');
  if(saveBtn){
    saveBtn.onclick = async () => {
      const statusEl = document.getElementById('profileStatus');
      const newEmailEl = document.getElementById('profileNewEmail');
      const curPwEl = document.getElementById('profileCurrentPassword');
      const newPwEl = document.getElementById('profileNewPassword');
      const nameEl = document.getElementById('profileFullName');
      const birthEl = document.getElementById('profileBirthDate');
      const phoneEl = document.getElementById('profilePhone');
      const setStatus = (msg) => { if(statusEl) statusEl.textContent = msg; };

      const newEmail = (newEmailEl.value || '').trim();
      const curPw = curPwEl.value;
      const newPw = newPwEl.value;
      const messages = [];

      saveBtn.disabled = true;

      // Password: requires proving you know the CURRENT one first, via a
      // real sign-in check — updateUser() alone would let anyone with an
      // unattended open session set a new password with no verification
      // at all, since it doesn't ask for the old one on its own.
      if(newPw){
        if(!curPw){ setStatus('Enter your current password to set a new one.'); saveBtn.disabled = false; return; }
        if(newPw.length < 6){ setStatus('New password should be at least 6 characters.'); saveBtn.disabled = false; return; }
        setStatus('Verifying current password…');
        const { error: verifyErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password: curPw });
        if(verifyErr){ setStatus('Current password is incorrect.'); saveBtn.disabled = false; return; }
        const { data: pwData, error: pwErr } = await sb.auth.updateUser({ password: newPw });
        if(pwErr){ messages.push('Password: ' + pwErr.message); }
        else { currentUser = pwData.user; messages.push('Password updated.'); curPwEl.value = ''; newPwEl.value = ''; }
      }

      // Email: Supabase emails a confirmation link to the new address (and
      // typically notifies the old one too) — the change only takes effect
      // once that's clicked, same as the sign-up confirmation flow. Correct
      // behavior, not something to route around.
      if(newEmail && newEmail !== currentUser.email){
        const { error: emailErr } = await sb.auth.updateUser({ email: newEmail });
        if(emailErr){ messages.push('Email: ' + emailErr.message); }
        else { messages.push(`Confirm the change via the link sent to ${newEmail}.`); newEmailEl.value = ''; }
      }

      // Personal info lives in Supabase's own per-user metadata — merge
      // with whatever's already there rather than overwrite it outright,
      // since updateUser({data}) replaces the whole object.
      const meta = { ...(currentUser.user_metadata || {}) };
      let metaChanged = false;
      if(nameEl.value.trim() !== (meta.full_name || '')){ meta.full_name = nameEl.value.trim(); metaChanged = true; }
      if(birthEl.value !== (meta.birth_date || '')){ meta.birth_date = birthEl.value; metaChanged = true; }
      if(phoneEl.value.trim() !== (meta.phone_number || '')){ meta.phone_number = phoneEl.value.trim(); metaChanged = true; }
      if(metaChanged){
        const { data: metaData, error: metaErr } = await sb.auth.updateUser({ data: meta });
        if(metaErr){ messages.push('Info: ' + metaErr.message); }
        else { currentUser = metaData.user; messages.push('Info saved.'); }
      }

      saveBtn.disabled = false;
      setStatus(messages.length ? messages.join(' ') : 'Nothing to update.');
    };
  }

  const signOutBtn = document.getElementById('profileSignOutBtn');
  if(signOutBtn){
    signOutBtn.onclick = async () => {
      await sb.auth.signOut();
    };
  }
}

// Own visibility, tracked independently of auth.js's element toggling —
// shown whenever there's a session, hidden otherwise, same rule auth.js
// applies to the rest of the bottom bar, just derived separately here.
sb.auth.onAuthStateChange((event, session) => {
  if(profileBtnEl) profileBtnEl.style.display = (session && session.user) ? '' : 'none';
  if(!session){ profileView = 'menu'; profileLastActiveTab = null; }
});
sb.auth.getSession().then(({ data }) => {
  if(profileBtnEl) profileBtnEl.style.display = (data && data.session && data.session.user) ? '' : 'none';
});

applyTheme(getSavedTheme());
