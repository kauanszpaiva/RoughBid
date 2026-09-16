const modal = document.querySelector('#access-modal');
const form = document.querySelector('#access-form');
const email = document.querySelector('#access-email');
const companySize = document.querySelector('#company-size');
const toast = document.querySelector('#success-toast');
let lastTrigger = null;

function openModal(event) {
  lastTrigger = event.currentTarget;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  window.requestAnimationFrame(() => modal.classList.add('is-open'));
  email.focus();
}

function closeModal() {
  modal.classList.remove('is-open');
  document.body.classList.remove('modal-open');
  window.setTimeout(() => { modal.hidden = true; }, 180);
  lastTrigger?.focus();
}

document.querySelectorAll('[data-open-access]').forEach((button) => button.addEventListener('click', openModal));
document.querySelectorAll('[data-close-access]').forEach((button) => button.addEventListener('click', closeModal));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) closeModal(); });

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
  document.querySelector('#email-error').textContent = validEmail ? '' : 'Enter a valid work email address.';
  document.querySelector('#size-error').textContent = companySize.value ? '' : 'Select your company size.';
  email.toggleAttribute('aria-invalid', !validEmail);
  companySize.toggleAttribute('aria-invalid', !companySize.value);
  if (!validEmail || !companySize.value) return;

  closeModal();
  form.reset();
  toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 4500);
});
