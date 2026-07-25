(function () {
    'use strict';

    const storageKey = 'dataexpress-theme';
    const root = document.documentElement;
    const media = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

    function storedTheme() {
        try {
            const value = window.localStorage.getItem(storageKey);
            return value === 'dark' || value === 'light' ? value : '';
        } catch (_) {
            return '';
        }
    }

    function systemTheme() {
        return media && media.matches ? 'dark' : 'light';
    }

    function applyTheme(value) {
        root.dataset.theme = value;
        root.style.colorScheme = value;
        const button = document.getElementById('theme-toggle');
        if (!button) return;
        const dark = value === 'dark';
        button.textContent = dark ? '☀' : '☾';
        button.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
        button.title = dark ? 'Светлая тема' : 'Тёмная тема';
        button.setAttribute('aria-pressed', String(dark));
    }

    applyTheme(storedTheme() || systemTheme());

    window.addEventListener('DOMContentLoaded', function () {
        if (document.getElementById('theme-toggle')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'theme-toggle';
        button.className = 'theme-toggle';
        button.addEventListener('click', function () {
            const value = root.dataset.theme === 'dark' ? 'light' : 'dark';
            try {
                window.localStorage.setItem(storageKey, value);
            } catch (_) {
                // The selected theme still applies for this page.
            }
            applyTheme(value);
        });
        document.body.appendChild(button);
        applyTheme(root.dataset.theme || systemTheme());
    });

    if (media && media.addEventListener) {
        media.addEventListener('change', function () {
            if (!storedTheme()) applyTheme(systemTheme());
        });
    }
}());
