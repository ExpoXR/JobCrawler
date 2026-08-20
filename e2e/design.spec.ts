import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const widths = [320, 390, 768, 1024, 1440];

for (const width of widths) {
  test(`home and search fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Employment research, mapped.' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );

    await page.goto('/search?mode=jobs');
    await expect(page.getByRole('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  });
}

test('theme preference resolves before hydration and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme').selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
});

test('global footer shows attribution and version', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByText('Made with Love by Ayal Othman from ExpoXR')).toBeVisible();
  await expect(footer.getByText('Version 0.1.0')).toBeVisible();
});

test('mobile filters collapse without hiding the search workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search?mode=jobs');
  const filters = page.locator('details.filter-disclosure');
  await expect(filters).toHaveAttribute('open', '');
  await filters.locator('summary').click();
  await expect(filters).not.toHaveAttribute('open', '');
  await expect(page.getByText('Enter a location and press Search.')).toBeVisible();
});

test('filter panel scrolls on its own without moving the page', async ({ page }) => {
  // Short enough that the filter form cannot fit, which is the case that used
  // to clip the Search button out of reach.
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto('/search?mode=jobs');

  const body = page.locator('.filters-body');
  await expect(body).toBeVisible();

  const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflows).toBe(true);

  await body.evaluate((el) => el.scrollBy(0, 400));

  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The submit button lives outside the scrolling band, so it stays put.
  await expect(page.locator('[data-search-submit]')).toBeInViewport();
});

test('reduced motion and 200 percent zoom remain usable', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/');
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect(page.getByRole('heading', { name: 'Employment research, mapped.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const route of ['/', '/search?mode=jobs', '/search?mode=candidates']) {
  test(`${route} has no serious axe violations`, async ({ page }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual(
      [],
    );
  });
}

test('skip link and primary controls are keyboard reachable', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
