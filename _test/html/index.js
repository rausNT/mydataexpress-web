function connectionPath(value) {
	const name = value.trim();
	if (!/^[A-Za-z0-9_]+$/.test(name)) return '';
	return '/' + encodeURIComponent(name.toLowerCase()) + '/';
}

function submitConnection(event) {
	event.preventDefault();
	const form = event.currentTarget;
	const input = form.elements.connection;
	const error = document.getElementById('connection-error');
	const path = connectionPath(input.value);

	if (!path) {
		input.setAttribute('aria-invalid', 'true');
		error.textContent = input.dataset.invalid || '';
		input.focus();
		return;
	}

	input.removeAttribute('aria-invalid');
	error.textContent = '';
	window.location.assign(path);
}

window.addEventListener('DOMContentLoaded', () => {
	const form = document.getElementById('connection-form');
	if (form) form.addEventListener('submit', submitConnection);
});
