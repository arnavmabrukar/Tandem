import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, persona = 'arnav', path = '/') {
  await page.goto(`/#${path}`);
  await page.getByLabel('Demo persona').selectOption(persona);
  await page.getByRole('button', { name: 'Enter demo' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading project snapshot' }),
  ).toHaveCount(0);
}
async function nav(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).click();
}

test('all screens render without page errors, external calls or horizontal page overflow', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await signIn(page);
  for (const [link, title] of [
    ['Activity', 'Activity'],
    ['Tasks', 'Tasks'],
    ['Agents', 'Agent connections'],
    ['Approvals', 'Human approvals'],
    ['Project setup', 'Project setup'],
    ['Connection guide', 'Connection guide'],
  ]) {
    await nav(page, link);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    if (link === 'Activity')
      await page.screenshot({ path: testInfo.outputPath('activity.png'), fullPage: true });
  }
  await nav(page, 'Tasks');
  await page.getByRole('link', { name: /Build project overview/ }).click();
  await expect(page.getByRole('heading', { name: 'Thread discussion' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('thread.png'), fullPage: true });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('creates a task, safely renders a note, persists and isolates project data', async ({
  page,
}) => {
  await signIn(page);
  await nav(page, 'Tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title', { exact: true }).fill('Frontend acceptance test');
  await dialog
    .getByLabel('Description', { exact: true })
    .fill('Exercise local creation and persistence.');
  await dialog.getByLabel('Proposed agent').selectOption('codex');
  await dialog.getByLabel('File scope').fill('apps/web/src/example.ts');
  await dialog.getByLabel('Acceptance criteria').fill('The task is persisted.');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Frontend acceptance test' })).toBeVisible();
  const note = '<script>window.stolen=true</script> Plain text only.';
  await page.getByLabel('Human note').fill(note);
  await page.getByRole('button', { name: 'Post note' }).click();
  await expect(page.locator('.messages').getByText(note, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Human note')).toHaveValue('');
  await page.reload();
  await expect(page.locator('.messages').getByText(note, { exact: true })).toBeVisible();
  await page.getByLabel('Select project').selectOption('sandbox');
  await nav(page, 'Tasks');
  await expect(page.getByText('No matching tasks', { exact: true })).toBeVisible();
  await expect(page.getByText('Frontend acceptance test', { exact: true })).toHaveCount(0);
  await page.getByLabel('Select project').selectOption('tandem');
  await nav(page, 'Tasks');
  await page.getByLabel('Search tasks').fill('Frontend acceptance');
  await expect(page.getByText('1 of 7 tasks')).toBeVisible();
});

test('failed save retains the draft and retry adds exactly one message', async ({ page }) => {
  await signIn(page, 'arnav', '/projects/tandem/tasks/task-dashboard');
  await page.getByText('Demo controls', { exact: true }).click();
  await page.getByRole('button', { name: 'Fail next save' }).click();
  await page.getByRole('button', { name: 'Reply to #1' }).click();
  await page.getByLabel('Human note').fill('A retryable note');
  await page.getByRole('button', { name: 'Post note' }).click();
  await expect(page.getByRole('alert')).toContainText('Simulated save failure');
  await expect(page.getByLabel('Human note')).toHaveValue('A retryable note');
  await page.getByRole('button', { name: 'Post note' }).click();
  await expect(
    page.locator('.messages').getByText('A retryable note', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel('Human note')).toHaveValue('');
  await expect(page.getByText('Reply to #1 — Arnav’s Codex')).toHaveCount(2);
});

test('review requires explicit target acknowledgment and never marks code merged', async ({
  page,
}) => {
  await signIn(page);
  await nav(page, 'Approvals');
  await page.getByRole('button', { name: 'Review target' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Record approval' })).toBeDisabled();
  await dialog.getByLabel('Review note').fill('Reviewed the exact demo head and evidence.');
  await dialog.getByLabel('I reviewed this action, version and exact head.').check();
  await dialog.getByRole('button', { name: 'Record approval' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Reviewed the exact demo head and evidence.')).toBeVisible();
  await page.getByRole('link', { name: 'Review human session flow', exact: true }).click();
  await expect(page.getByText('Not merged', { exact: true })).toBeVisible();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
});

test('an open review is disabled when another tab changes its head', async ({ page, context }) => {
  await signIn(page);
  await nav(page, 'Approvals');
  await page.getByRole('button', { name: 'Review target' }).click();
  const second = await context.newPage();
  await signIn(second);
  await second.getByText('Demo controls', { exact: true }).click();
  await second.getByRole('button', { name: 'Change review head' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('no longer current');
  await expect(page.getByRole('button', { name: 'Record approval' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Stale', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review target' })).toHaveCount(1);
});

test('viewer cannot mutate and deep links survive demo sign-in', async ({ page }) => {
  await signIn(page, 'guest', '/projects/tandem/approvals');
  await expect(page.getByRole('heading', { name: 'Human approvals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review target' })).toBeDisabled();
  await nav(page, 'Tasks');
  await expect(page.getByRole('button', { name: 'New task' })).toBeDisabled();
  await page.getByRole('link', { name: /Build project overview/ }).click();
  await expect(page.getByLabel('Human note')).toHaveCount(0);
  await nav(page, 'Agents');
  await expect(page.getByRole('button', { name: 'Add agent record' })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enter demo' })).toBeVisible();
});

test('sets up a project, invitations and pending agent records', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: '+ Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('UI sandbox');
  await page.getByLabel('GitHub repository', { exact: true }).fill('example/testing');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await nav(page, 'Project setup');
  await page.getByLabel('Invitation email').fill('teammate@example.test');
  await page.getByRole('button', { name: 'Create invitation record' }).click();
  await expect(page.getByText('teammate@example.test', { exact: true })).toBeVisible();
  await nav(page, 'Agents');
  await page.getByRole('button', { name: 'Add agent record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Agent name', { exact: true }).fill('Test agent');
  await dialog.getByLabel('Machine label').fill('Independent laptop');
  await dialog.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test agent' })).toBeVisible();
  await expect(page.getByRole('article').getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.getByRole('article').getByText('Offline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke demo grant' }).click();
  await page.getByRole('button', { name: 'Confirm revocation' }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
});

test('offline states are visible and empty fixtures recover without a reload', async ({ page }) => {
  await signIn(page);
  await page.getByText('Demo controls', { exact: true }).click();
  await page.getByLabel('Connection simulation').selectOption('offline');
  await expect(page.getByRole('alert')).toContainText('offline');
  await page.getByLabel('Connection simulation').selectOption('normal');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load empty data', exact: true }).click();
  await page.getByRole('button', { name: 'Replace demo data' }).click();
  await expect(page.getByText('No activity to show', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset sample data', exact: true }).click();
  await page.getByRole('button', { name: 'Replace demo data' }).click();
  await expect(page.getByText('Needs a closer look', { exact: true })).toBeVisible();
});
