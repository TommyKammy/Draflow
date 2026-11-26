import type { Page } from '@playwright/test';

export async function setEnglish(page: Page) {
  await page.locator('draflow-editor').evaluate(el => el.setAttribute('locale', 'en'));
}

export async function openEnglishDemo(page: Page) {
  await page.goto('/');
  await setEnglish(page);
}
