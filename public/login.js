const msg = document.getElementById('msg');
const btn = document.getElementById('go');

async function login() {
  msg.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        role: ROLE,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not sign in');
    location.href = '/dashboard.html';
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

btn.addEventListener('click', login);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
