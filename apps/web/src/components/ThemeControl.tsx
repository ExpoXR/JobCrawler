'use client';

import { useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'expojobcrawler-theme';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark';
}

function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  root.dataset.theme = preference;
  root.dataset.expoTheme = preference;
  root.dataset.themePreference = preference;
}

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>('dark');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const initial = isThemePreference(stored) ? stored : 'dark';
    if (stored !== initial) window.localStorage.setItem(STORAGE_KEY, initial);
    setPreference(initial);
    applyTheme(initial);
  }, []);

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
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}
