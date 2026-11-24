import { expect, test } from '@playwright/test';

import { backendFetch } from './helpers/backendApi';
import { homeStats, shown, statValue, type HomeStats } from './helpers/processFlow';
import { logResult } from './helpers/processesPage';
import {
  EXPECTED_MENUS,
  HOME_TASKS_ROLES,
  HOME_TOTAL_TENANTS_ROLES,
  MENUS,
  ROLES,
  SETUP_ROLES,
  SYSTEM_CHILDREN,
  pageRefused,
  permissionsCheck,
  role,
  serverAllows,
  signInAs,
  visibleMenus,
} from './helpers/rbac';
import { seedBaselineOnce } from './seed/seed';

/**
 *
 * RBAC-NAV  the sidebar shows exactly the role's menus, and the server agrees with each one
 *           (TC-M8F-RBAC-001..029, TC-013: Messages for Super Admin, Tenant Admin, Editor; TC-283)
 * RBAC-URL  a page whose menu is hidden cannot be opened by typing its address (TC-284)
 * RBAC-HOME the Home cards and lists per role, and their numbers match the server (TC-030..034)
 * RBAC-GRP  the Setup and System groups per role; NATS for Super Admin and (own events) Tenant Admin (TC-027..029)
 * RBAC-SA   Super Admin's tenant drop-down lists All tenants + every tenant; menus stay the same
 *           with one tenant selected (TC-293)
 *
 * Expected menus: helpers/rbac.ts (EXPECTED_MENUS). Nothing is created; the seeded users are used.
 */

test.describe('RBAC: navigation per role', { tag: ['@rbac', '@permissions'] }, () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(480_000);
    await seedBaselineOnce(browser);
  });

  for (const r of ROLES) {
    test(`RBAC-NAV [${r.label}]: The sidebar shows exactly the role's menus and the server agrees`, async ({ page }) => {
      await signInAs(page, r);
      const shown = await visibleMenus(page);
      const expected = EXPECTED_MENUS[r.key];
      const missing = expected.filter((m) => !shown.includes(m));
      const extra = shown.filter((m) => !expected.includes(m));

      // The server's answer for each menu: the real API where the app decides by role (Tenants),
      // else the permission check the app itself asks.
      const allowed = await serverAllows(page);
      const disagree = MENUS.filter((m) => {
        // Super Admin reaches a tenant's admin page from Tenants; it has no menu of its own.
        if (r.key === 'superAdmin' && m.name === 'Tenant Management') return false;
        return allowed[m.name] !== shown.includes(m.name);
      }).map((m) => `${m.name} (menu ${shown.includes(m.name) ? 'shown' : 'hidden'}, server ${allowed[m.name] ? 'allows' : 'refuses'})`);

      expect.soft(missing, `${r.label}: menus that should be shown but are not`).toEqual([]);
      expect.soft(extra, `${r.label}: menus that are shown but should not be`).toEqual([]);
      expect.soft(disagree, `${r.label}: menus where the screen and the server disagree`).toEqual([]);

      logResult(`RBAC-NAV [${r.label}]`, {
        scenario: `Sidebar of the ${r.label}`,
        actions: [`Login to M8Flow as ${r.label}`, 'Read the sidebar menus', 'Ask the server for each menu (permissions-check, or the API itself)'],
        expected: `Home + ${expected.join(', ')}`,
        actual: `Home + ${shown.join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}${disagree.length ? `; disagree: ${disagree.join('; ')}` : ''}`,
      });
    });

    test(`RBAC-URL [${r.label}]: Pages hidden from the role cannot be opened by their address`, async ({ page }) => {
      await signInAs(page, r);
      const hidden = MENUS.filter((m) => !EXPECTED_MENUS[r.key].includes(m.name))
        // Super Admin opens a tenant's admin page from Tenants (not a menu of its own).
        .filter((m) => !(r.key === 'superAdmin' && m.name === 'Tenant Management'));
      const opened: string[] = [];
      const results: string[] = [];
      for (const m of hidden) {
        const { refused, landed } = await pageRefused(page, m.path);
        results.push(`${m.path} -> ${refused ? `refused (${landed})` : 'OPENED'}`);
        if (!refused) opened.push(m.path);
      }
      expect(opened, `${r.label}: hidden pages that open by address`).toEqual([]);

      logResult(`RBAC-URL [${r.label}]`, {
        scenario: `${r.label} types the address of each page whose menu is hidden`,
        actions: hidden.map((m) => m.path),
        expected: 'Each page is refused: the user is sent elsewhere or sees a not-authorised message',
        actual: results.join('; ') || 'no hidden pages',
      });
    });
  }

  for (const r of ROLES) {
    test(`RBAC-HOME [${r.label}]: Home shows the role's cards and lists, with the server's numbers`, async ({ page }) => {
      await signInAs(page, r);
      await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
      const wantTasks = HOME_TASKS_ROLES.includes(r.key);
      const wantTenants = HOME_TOTAL_TENANTS_ROLES.includes(r.key);
      const wantRecent = EXPECTED_MENUS[r.key].includes('Process Instances');
      const stats: HomeStats = await homeStats(page);

      const tasksCard = page.getByText('Tasks waiting on me', { exact: true });
      const tenantsCard = page.getByText('Total tenants', { exact: true });
      // The stat cards are drawn once the stats have loaded (Active process instances is always shown).
      await expect(page.getByText('Active process instances', { exact: true })).toBeVisible();
      await expect(tasksCard).toHaveCount(wantTasks ? 1 : 0);
      await expect(tenantsCard).toHaveCount(wantTenants ? 1 : 0);
      await expect(page.getByRole('heading', { name: 'My tasks', exact: true })).toHaveCount(wantTasks ? 1 : 0);
      await expect(page.getByRole('heading', { name: 'Recent process instances', exact: true })).toHaveCount(wantRecent ? 1 : 0);
      if (wantTasks) await expect(statValue(page, 'Tasks waiting on me')).toHaveText(shown(stats.tasks_waiting_on_me));
      if (wantTenants) await expect(statValue(page, 'Total tenants')).toHaveText(shown(stats.total_tenants));
      // The server gives the tenant count to the Super Admin only.
      if (!wantTenants) expect(stats.total_tenants, 'Total tenants is not given to this role').toBeNull();

      logResult(`RBAC-HOME [${r.label}]`, {
        scenario: `Home of the ${r.label}`,
        actions: [`Login to M8Flow as ${r.label}`, 'Read the Home cards and lists', 'Compare with GET /v1.0/m8flow/home-stats'],
        expected: `Tasks waiting on me + My tasks: ${wantTasks ? 'shown' : 'hidden'}; Total tenants: ${wantTenants ? 'shown' : 'hidden'}; Recent process instances: ${wantRecent ? 'shown' : 'hidden'}; numbers as the server's`,
        actual: `As expected; tasks waiting ${shown(stats.tasks_waiting_on_me)}, total tenants ${shown(stats.total_tenants)}`,
      });
    });

    test(`RBAC-GRP [${r.label}]: The Setup and System groups show only the role's items`, async ({ page }) => {
      await signInAs(page, r);
      const nav = page.locator('aside nav');
      await visibleMenus(page);
      const wantSetup = SETUP_ROLES.includes(r.key);
      const wantSystem = SYSTEM_CHILDREN[r.key] ?? [];
      await expect(nav.getByRole('button', { name: 'Setup', exact: true }), 'Setup group').toHaveCount(wantSetup ? 1 : 0);
      await expect(nav.getByRole('button', { name: 'System', exact: true }), 'System group').toHaveCount(wantSystem.length ? 1 : 0);
      for (const child of ['Celery', 'NATS']) {
        await expect(nav.getByRole('link', { name: child, exact: true }), `System > ${child}`).toHaveCount(wantSystem.includes(child) ? 1 : 0);
      }
      // NATS (streams and event history) is Super Admin only (M8F-700).
      const nats = await permissionsCheck(page, [['/m8flow/nats/streams', 'GET'], ['/m8flow/nats/events', 'GET']]);
      const streams = Boolean(nats['/m8flow/nats/streams']?.GET);
      const events = Boolean(nats['/m8flow/nats/events']?.GET);
      expect(streams, 'NATS streams (full monitor)').toBe(r.key === 'superAdmin');
      expect(events, 'NATS event history').toBe(wantSystem.includes('NATS'));
      expect((await pageRefused(page, '/system/nats')).refused, `the NATS page ${wantSystem.includes('NATS') ? 'opens' : 'is refused'}`).toBe(!wantSystem.includes('NATS'));

      logResult(`RBAC-GRP [${r.label}]`, {
        scenario: `Setup and System groups of the ${r.label}`,
        actions: [`Login to M8Flow as ${r.label}`, 'Look for the Setup and System groups and their items', 'Ask the server about NATS streams and events'],
        expected: `Setup ${wantSetup ? 'shown' : 'hidden'}; System ${wantSystem.length ? `shown with ${wantSystem.join(', ')}` : 'hidden'}`,
        actual: `As expected; NATS streams ${streams ? 'allowed' : 'refused'}, NATS events ${events ? 'allowed' : 'refused'}`,
      });
    });
  }

  test('RBAC-SA: Super Admin picks All tenants or one tenant; the menus stay the same', async ({ page }) => {
    await signInAs(page, role('superAdmin'));
    const picker = page.locator('aside').getByRole('combobox', { name: 'Tenant', exact: true });
    await expect(picker).toBeVisible();
    const registry = await backendFetch(page, '/v1.0/m8flow/tenants');
    expect(registry.status, 'GET /v1.0/m8flow/tenants').toBe(200);
    const body = registry.body as { results?: { name: string; slug: string; status?: string }[] } | { name: string; slug: string; status?: string }[];
    const tenants = (Array.isArray(body) ? body : body.results ?? []).filter((t) => (t.status ?? 'ACTIVE') !== 'DELETED');

    await picker.click();
    const options = (await page.getByRole('option').allInnerTexts()).map((o) => o.trim());
    expect(options.at(0), 'the first option').toBe('All tenants');
    const missing = tenants.filter((t) => !options.includes(t.name)).map((t) => t.name);
    expect(missing, 'tenants in the registry that are not offered').toEqual([]);

    const allMenus = await (async () => {
      await page.keyboard.press('Escape');
      return visibleMenus(page);
    })();
    const one = tenants.find((t) => t.slug === 'm8flow') ?? tenants.at(0)!;
    await picker.click();
    await page.getByRole('option', { name: one.name, exact: true }).click();
    await expect(picker).toContainText(one.name);
    const oneMenus = await visibleMenus(page);
    expect(oneMenus.sort(), `menus with ${one.name} selected`).toEqual([...allMenus].sort());

    // Back to All tenants, so the other tests start from the default.
    await picker.click();
    await page.getByRole('option', { name: 'All tenants', exact: true }).click();
    await expect(picker).toContainText('All tenants');

    logResult('RBAC-SA', {
      scenario: 'Super Admin tenant drop-down',
      actions: ['Login to M8Flow as Super Admin', 'Open the Tenant drop-down', `Pick ${one.name}`, 'Compare the menus', 'Pick All tenants again'],
      expected: 'All tenants first, then every tenant of the registry; the same menus with one tenant selected',
      actual: `Options: ${options.join(', ')}; menus with ${one.name}: ${oneMenus.join(', ')}`,
    });
  });
});
