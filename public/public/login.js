const form = document.getElementById('loginForm');
const errorBox = document.getElementById('error');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.style.display = 'none';
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인에 실패했습니다.');
    window.location.href = '/';
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
  }
});
