/* ============================================================
   Tech Defenders Business OS - Auth page controller
   ============================================================ */
'use strict';

const Auth = {
  showTab(name) {
    const tabs = document.querySelector('.tabs');
    tabs.dataset.active = name;
    document.getElementById('tab-signin').classList.toggle('active', name === 'signin');
    document.getElementById('tab-register').classList.toggle('active', name === 'register');
    document.getElementById('form-signin').classList.toggle('hidden', name !== 'signin');
    document.getElementById('form-register').classList.toggle('hidden', name !== 'register');
    document.getElementById('form-reset').classList.add('hidden');
  },

  togglePw(inputId, btn) {
    const el = document.getElementById(inputId);
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  },
  async startLoginOtp() {
    const email = document.getElementById('si-email').value.trim();
    if (!email) return toast('Email required', 'Enter your work email first', 'warning');
    const button = document.getElementById('si-otp');
    button.disabled = true; button.textContent = 'Sending OTP...';
    try {
      const data = await Auth.post('/api/auth/login/request-otp', { email });
      Auth.openOtpVerify('login', data.challengeId, email);
      toast('OTP requested', data.message, 'success');
    } catch (error) {
      toast('OTP not sent', error.message, 'error');
    } finally {
      button.disabled = false; button.textContent = 'Sign in with Email OTP';
    }
  },

  async post(url, body) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.code = data.code;
      throw error;
    }
    return data;
  },

  openOtpVerify(purpose, challengeId, email) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const heading = purpose === 'signup' ? 'Verify and create workspace' : 'Email OTP sign in';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="otp-title">
        <div class="modal-head"><div><span class="eyebrow">SECURE EMAIL CHECK</span><h3 id="otp-title">${heading}</h3></div><button class="modal-x" data-close aria-label="Close">&times;</button></div>
        <form id="otp-form">
          <div class="modal-body otp-modal-body">
            <p class="muted">Enter the 6-digit code sent to <b>${Auth.escape(email)}</b>. The code expires in 10 minutes.</p>
            <label class="field"><span>Verification code</span><input id="otp-code" class="otp-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label>
            <div class="otp-security-note"><b>Keep it private</b><span>Tech Defenders will never ask you to share this code.</span></div>
          </div>
          <div class="modal-foot"><button type="button" class="btn btn-outline" data-close>Cancel</button><button type="submit" class="btn btn-gold" id="otp-verify">Verify OTP</button></div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => {
      backdrop.remove();
      const registerButton = document.getElementById('rg-submit');
      if (registerButton) { registerButton.disabled = false; registerButton.textContent = 'Email OTP & Create Workspace'; }
    };
    backdrop.querySelectorAll('[data-close]').forEach(button => button.onclick = close);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    const codeInput = backdrop.querySelector('#otp-code');
    codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });
    backdrop.querySelector('#otp-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = backdrop.querySelector('#otp-verify');
      button.disabled = true; button.textContent = 'Verifying...';
      try {
        await Auth.post(`/api/auth/${purpose === 'signup' ? 'register' : 'login'}/verify-otp`, { challengeId, otp: codeInput.value });
        toast('Email verified', purpose === 'signup' ? 'Workspace created successfully' : 'Signed in successfully', 'success');
        setTimeout(() => { location.href = '/app.html'; }, 350);
      } catch (error) {
        toast('OTP verification failed', error.message, 'error');
        button.disabled = false; button.textContent = 'Verify OTP'; codeInput.select();
      }
    });
    setTimeout(() => codeInput.focus(), 40);
  },

  escape(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  },

  openForgot() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h3>Forgot password</h3><button class="modal-x" data-close>&times;</button></div>
        <form id="forgot-form">
          <div class="modal-body">
            <p class="muted" style="margin-bottom:14px;font-size:13px">Enter your work email. If the account exists, reset instructions will be prepared. Ask your administrator if email delivery is not configured.</p>
            <label class="field"><span>Work email</span><input type="email" id="fp-email" required></label>
            <div id="fp-result" class="hidden"></div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-outline" data-close>Cancel</button>
            <button type="submit" class="btn btn-gold">Request password reset</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', e => { if (e.target === backdrop || e.target.hasAttribute('data-close')) backdrop.remove(); });
    backdrop.querySelector('#forgot-form').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const res = await fetch('/api/auth/forgot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('fp-email').value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        const box = backdrop.querySelector('#fp-result');
        box.classList.remove('hidden');
        box.textContent = data.message || 'If that account exists, reset instructions have been prepared.';
      } catch (err) { alert(err.message); }
    });
  }
};

window.Auth = Auth;

/* ---------- toast helper (shared) ---------- */
function toast(title, msg, kind) {
  const host = document.getElementById('toast-host') || (() => {
    const h = document.createElement('div'); h.id = 'toast-host'; h.className = 'toast-host'; document.body.appendChild(h); return h;
  })();
  const t = document.createElement('div');
  t.className = 'toast t-' + (kind || 'info');
  const heading = document.createElement('b');
  heading.textContent = String(title || 'Notice');
  t.append(heading, document.createTextNode(String(msg || '')));
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3800);
}
window.toast = toast;

/* ---------- sign in ---------- */
document.getElementById('form-signin').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('si-submit');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('si-email').value,
        password: document.getElementById('si-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign in failed');
    location.href = '/app.html';
  } catch (err) {
    toast('Sign in failed', err.message, 'error');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
});

/* ---------- register ---------- */
document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('rg-password').value;
  const pw2 = document.getElementById('rg-confirm').value;
  if (pw !== pw2) return toast('Check details', 'Passwords do not match', 'error');
  if (!document.getElementById('rg-terms').checked) return toast('Terms', 'Please accept the terms to continue', 'warning');

  const btn = document.getElementById('rg-submit');
  btn.disabled = true; btn.textContent = 'Creating workspace...';
  try {
    const data = await Auth.post('/api/auth/register/request-otp', {
        name: document.getElementById('rg-name').value,
        company: document.getElementById('rg-company').value,
        email: document.getElementById('rg-email').value,
        password: pw,
        phone: document.getElementById('rg-phone').value,
        stateCode: document.getElementById('rg-state').value
    });
    Auth.openOtpVerify('signup', data.challengeId, document.getElementById('rg-email').value.trim());
    toast('OTP sent', data.message, 'success');
  } catch (err) {
    toast('Registration failed', err.message, 'error');
    btn.disabled = false; btn.textContent = 'Email OTP & Create Workspace';
  }
});

/* ---------- reset ---------- */
document.getElementById('form-reset').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const res = await fetch('/api/auth/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: document.getElementById('rs-token').value.trim(),
        password: document.getElementById('rs-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reset failed');
    toast('Password updated', data.message, 'success');
    Auth.showTab('signin');
  } catch (err) { toast('Reset failed', err.message, 'error'); }
});
