'use client';

import { useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'expojobcrawler-theme';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  return preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light';
}

function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.expoTheme = resolved;
  root.dataset.themePreference = preference;
}

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>('light');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const initial = isThemePreference(stored) ? stored : 'light';
    setPreference(initial);
    applyTheme(initial);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(preference);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const update = (next: ThemePreference) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setPreference(next);
    applyTheme(next);
  };

  return (
    <label className="theme-control" htmlFor="theme-preference">
      <span>Theme</span>
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => update(event.target.value as ThemePreference)}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
