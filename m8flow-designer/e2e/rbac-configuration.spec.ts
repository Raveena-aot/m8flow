import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { tenantAdminCredentials } from './helpers/auth';
import { backendFetch, getTenantBySlug } from './helpers/backendApi';
import { PARITY_SECOND_TENANT_SLUG, SEED_TENANT_SLUG } from './helpers/fixtures';
import { newStamp } from './helpers/mockCatalog';
import { closeRolePages, withPage } from './helpers/processFlow';
import { logResult } from './helpers/processesPage';
import { pageRefused, role, selectTenantAsSuperAdmin, signInAs, type RoleKey } from './helpers/rbac';
import { seedBaselineOnce } from './seed/seed';

/**
 * RBAC: Configuration (secrets), connector profiles and API keys per role.
 *
 * RBAC-SEC-LIST     who can list secrets (TC-139, 140)
 * RBAC-SEC-WRITE    create, edit and delete a secret in the UI (TC-141, 143, 145)
 * RBAC-SEC-DENIED   no create / edit / delete; the API refuses (TC-142, 144, 146)
 * RBAC-SEC-MASK     a secret's value is never shown or returned (TC-285)
 * RBAC-PROF-VIEW    who can see HTTP connector profiles (TC-152, 344; Super Admin All tenants: TC-312)
 * RBAC-PROF-WRITE   add, edit, deactivate / reactivate and delete a profile (TC-153, 155, 157, 159)
 * RBAC-PROF-DENIED  read-only profiles; the API refuses (TC-154, 156, 158, 160, 344, 345)
 * RBAC-PROF-MASK    a profile's password is never shown or returned (TC-286)
 * RBAC-PROF-SA      Super Admin's profile is saved in the selected tenant only (TC-313)
 * RBAC-KEY-VIEW     who can see API keys; Super Admin with All tenants is asked to pick one
 *                   (TC-169, 170, 317, 320)
 * RBAC-KEY-MANAGE   Tenant Admin creates (key shown once) and revokes a key (TC-171, 343)
 * RBAC-KEY-SA       Super Admin views keys but cannot create or revoke them (TC-173, 318, 319)
 * RBAC-KEY-DENIED   other roles cannot create or revoke keys through the API (TC-172)
 *
 * The tenant admin creates one secret, one HTTP profile and one API key in tenant m8flow
 * first; everything is removed (keys revoked) afterwards.
 */

const stamp = newStamp();
const SEED = {
  secretKey: `E2E_RBAC_${stamp}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
  secretValue: `rbac-secret-value-${stamp}`,
  profileName: `e2e-rbac-${stamp}`,
  profileDisplay: `E2E RBAC ${stamp}`,
  profilePassword: `rbac-profile-pass-${stamp}`,
  keyLabel: `E2E RBAC key ${stamp}`,
};
const seeded = { profileId: 0, keyId: '' };
const created = { secrets: [] as string[], keys: [] as string[] };

const PROFILES_PATH = '/connectors/http/profiles';

/** Signs in; the Super Admin then works in tenant m8flow. */
async function enter(page: Page, key: RoleKey): Promise<void> {
  await signInAs(page, role(key));
  if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, SEED_TENANT_SLUG);
}

async function leave(page: Page, key: RoleKey): Promise<void> {
  if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
}

const asAdmin = <T>(browser: Browser, fn: (p: Page) => Promise<T>) => withPage(browser, tenantAdminCredentials(), fn);

/** A confirm dialog by its title (alert dialog or dialog). */
const confirmDialog = (page: Page, title: string): Locator =>
  page.getByRole('alertdialog', { name: title }).or(page.getByRole('dialog', { name: title }));

/** The table row that contains `text`. */
const row = (page: Page, text: string): Locator => page.getByRole('row').filter({ hasText: text });

type Profile = { id: number; profile_name: string; display_name: string; is_active: boolean };
async function listProfiles(page: Page, tenantId?: string): Promise<Profile[]> {
  const q = `connector_type=http${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`;
  const result = await backendFetch(page, `/v1.0/m8flow/connector-profiles?${q}`);
  return Array.isArray(result.body) ? (result.body as Profile[]) : [];
}

type ApiKey = { id: string; label: string; revokedAtInSeconds?: number | null };
async function listKeys(page: Page): Promise<{ status: number; keys: ApiKey[]; raw: string }> {
  const result = await backendFetch(page, '/v1.0/m8flow/nats-tokens');
  const keys = ((result.body as { keys?: ApiKey[] } | null)?.keys ?? []) as ApiKey[];
  return { status: result.status, keys, raw: JSON.stringify(result.body ?? '') };
}

test.describe('RBAC: Configuration, connector profiles and API keys', { tag: ['@rbac', '@permissions'] }, () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(480_000);
    await seedBaselineOnce(browser);
    await asAdmin(browser, async (a) => {
      const secret = await backendFetch(a, '/v1.0/secrets', { method: 'POST', data: { key: SEED.secretKey, value: SEED.secretValue } });
      expect(secret.status, 'seed secret').toBeLessThan(300);
      const profile = await backendFetch(a, '/v1.0/m8flow/connector-profiles', {
        method: 'POST',
        data: {
          connector_type: 'http',
          profile_name: SEED.profileName,
          display_name: SEED.profileDisplay,
          description: 'E2E mock data -- safe to delete',
          config: { basic_auth_username: 'rbac-user', basic_auth_password: SEED.profilePassword },
        },
      });
      expect(profile.status, 'seed connector profile').toBeLessThan(300);
      seeded.profileId = (profile.body as { id: number }).id;
      const key = await backendFetch(a, '/v1.0/m8flow/nats-tokens', { method: 'POST', data: { label: SEED.keyLabel, expiresInDays: 30 } });
      expect(key.status, 'seed API key').toBeLessThan(300);
      seeded.keyId = (key.body as { id: string }).id;
    });
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await asAdmin(browser, async (a) => {
      for (const k of [SEED.secretKey, ...created.secrets]) await backendFetch(a, `/v1.0/secrets/${encodeURIComponent(k)}`, { method: 'DELETE' }).catch(() => null);
      for (const p of (await listProfiles(a)).filter((x) => x.profile_name.includes(stamp))) {
        await backendFetch(a, `/v1.0/m8flow/connector-profiles/${p.id}?hard=true`, { method: 'DELETE' }).catch(() => null);
      }
      for (const id of [seeded.keyId, ...created.keys].filter(Boolean)) {
        await backendFetch(a, `/v1.0/m8flow/nats-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
      }
    }).finally(closeRolePages);
  });

  // ===============================================================================================
  // Secrets
  // ===============================================================================================
  const SECRET_READERS: RoleKey[] = ['superAdmin', 'tenantAdmin', 'viewer', 'integrator'];
  const SECRET_WRITERS: RoleKey[] = ['superAdmin', 'tenantAdmin', 'integrator'];

  for (const key of ['superAdmin', 'tenantAdmin', 'viewer', 'integrator', 'editor', 'submitter'] as RoleKey[]) {
    const allowed = SECRET_READERS.includes(key);
    test(`RBAC-SEC-LIST [${role(key).label}]: ${allowed ? 'Lists' : 'Cannot list'} secrets`, async ({ page }) => {
      await enter(page, key);
      const listed = await backendFetch(page, '/v1.0/secrets');
      const api = listed.status;
      const rows = ((listed.body as { results?: unknown[] } | null)?.results ?? []).length;
      let landed = '/configuration/secrets';
      if (allowed) {
        await page.goto('/configuration/secrets');
        await expect(page.getByRole('heading', { level: 1, name: 'Configuration', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: SEED.secretKey, exact: true })).toBeVisible();
        expect(api, 'GET /secrets').toBe(200);
      } else {
        // Refused: sent elsewhere (Home) or a "Not available" card; never the list.
        const refused = await pageRefused(page, '/configuration/secrets');
        landed = refused.landed;
        expect(refused.refused, 'the secrets page is refused').toBe(true);
        await expect(page.getByRole('link', { name: SEED.secretKey, exact: true })).toHaveCount(0);
        // The server answers a role without access with an empty list (by design), or 403.
        expect([200, 403], 'GET /secrets').toContain(api);
        expect(rows, 'secrets returned to a role without access').toBe(0);
        expect(JSON.stringify(listed.body ?? ''), 'the seeded secret in the answer').not.toContain(SEED.secretKey);
      }
      await leave(page, key);
      logResult(`RBAC-SEC-LIST [${role(key).label}]`, {
        scenario: `${role(key).label} opens Configuration > Secrets`,
        actions: ['Open /configuration/secrets', 'GET /secrets'],
        expected: allowed ? `The secret ${SEED.secretKey} is listed; API 200` : 'Page refused (Home or "Not available"); API returns no secrets (empty list or 403)',
        actual: `API ${api} (${rows} secrets); page ${allowed ? 'listed' : `refused (${landed})`}`,
      });
    });
  }

  for (const key of SECRET_WRITERS) {
    test(`RBAC-SEC-WRITE [${role(key).label}]: Creates, edits and deletes a secret`, async ({ page, browser }) => {
      const secretKey = `E2E_RBAC_${key.toUpperCase()}_${stamp}`.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
      created.secrets.push(secretKey);
      await enter(page, key);
      await page.goto('/configuration/secrets');
      await page.getByRole('link', { name: 'Add a secret', exact: true }).click();
      await page.getByLabel('Secret key').fill(secretKey);
      await page.getByLabel('Value', { exact: true }).fill(`first-${stamp}`);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/configuration/secrets/${secretKey}`));
      const listed = await asAdmin(browser, async (a) => JSON.stringify((await backendFetch(a, '/v1.0/secrets')).body).includes(secretKey));
      expect(listed, 'the new secret is saved').toBe(true);

      await page.getByRole('button', { name: 'Edit value', exact: true }).click();
      await page.getByLabel('New value').fill(`second-${stamp}`);
      await page.getByRole('button', { name: 'Update value', exact: true }).click();
      await expect(page.getByText('Secret updated.', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await confirmDialog(page, 'Delete secret?').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect
        .poll(async () => asAdmin(browser, async (a) => JSON.stringify((await backendFetch(a, '/v1.0/secrets')).body).includes(secretKey)), {
          message: 'the secret is deleted',
          timeout: 15_000,
        })
        .toBe(false);
      await leave(page, key);
      logResult(`RBAC-SEC-WRITE [${role(key).label}]`, {
        scenario: `${role(key).label} manages a secret${key === 'superAdmin' ? ' (m8flow selected)' : ''}`,
        actions: ['Add a secret -> key and value -> Create', 'Edit value -> Update value', 'Delete -> Delete'],
        expected: 'Created; "Secret updated."; deleted',
        actual: `${secretKey} created, updated and deleted`,
      });
    });
  }

  for (const key of ['editor', 'viewer', 'submitter'] as RoleKey[]) {
    test(`RBAC-SEC-DENIED [${role(key).label}]: Cannot create, edit or delete a secret`, async ({ page, browser }) => {
      await enter(page, key);
      const reader = SECRET_READERS.includes(key);
      if (reader) {
        await page.goto('/configuration/secrets');
        await expect(page.getByRole('link', { name: SEED.secretKey, exact: true })).toBeVisible();
        await expect.soft(page.getByRole('link', { name: 'Add a secret', exact: true }), 'Add a secret').toHaveCount(0);
        await expect.soft(page.getByRole('button', { name: 'Delete', exact: true }), 'Delete in the list').toHaveCount(0);
        await page.goto('/configuration/secrets/new');
        await expect.soft(page.getByText('Not allowed', { exact: true }), 'new secret page refused').toBeVisible();
      } else {
        expect.soft((await pageRefused(page, '/configuration/secrets/new')).refused, 'new secret page refused').toBe(true);
      }
      await expect.soft(page.getByLabel('Secret key'), 'new secret form').toHaveCount(0);
      if (reader) {
        await page.goto(`/configuration/secrets/${SEED.secretKey}`);
        await expect(page.getByRole('heading', { level: 1, name: SEED.secretKey })).toBeVisible();
        await expect.soft(page.getByRole('button', { name: 'Edit value', exact: true }), 'Edit value').toHaveCount(0);
        await expect.soft(page.getByRole('button', { name: 'Delete', exact: true }), 'Delete').toHaveCount(0);
      }
      const post = (await backendFetch(page, '/v1.0/secrets', { method: 'POST', data: { key: `E2E_DENIED_${stamp}`.toUpperCase(), value: 'x' } })).status;
      const put = (await backendFetch(page, `/v1.0/secrets/${SEED.secretKey}`, { method: 'PUT', data: { value: 'changed' } })).status;
      const del = (await backendFetch(page, `/v1.0/secrets/${SEED.secretKey}`, { method: 'DELETE' })).status;
      expect.soft(post, 'create through the API').toBe(403);
      expect.soft(put, 'edit through the API').toBe(403);
      expect.soft(del, 'delete through the API').toBe(403);
      const still = await asAdmin(browser, async (a) => (await backendFetch(a, `/v1.0/secrets/${SEED.secretKey}`)).status);
      expect(still, 'the secret is still there').toBe(200);
      logResult(`RBAC-SEC-DENIED [${role(key).label}]`, {
        scenario: `${role(key).label} tries to change secrets`,
        actions: ['Look for Add a secret / Edit value / Delete', 'Open /configuration/secrets/new', 'POST, PUT and DELETE through the API'],
        expected: `No buttons; new page ${reader ? 'shows "Not allowed"' : 'refused'}; API 403 for all; the secret is unchanged`,
        actual: `POST ${post}, PUT ${put}, DELETE ${del}; secret still there`,
      });
    });
  }

  for (const key of ['tenantAdmin', 'viewer', 'integrator'] as RoleKey[]) {
    test(`RBAC-SEC-MASK [${role(key).label}]: A secret's value is never shown or returned`, async ({ page }) => {
      await enter(page, key);
      const list = JSON.stringify((await backendFetch(page, '/v1.0/secrets')).body ?? '');
      const item = JSON.stringify((await backendFetch(page, `/v1.0/secrets/${SEED.secretKey}`)).body ?? '');
      expect.soft(list.includes(SEED.secretValue), 'the value in the list API').toBe(false);
      expect.soft(item.includes(SEED.secretValue), 'the value in the item API').toBe(false);
      await page.goto(`/configuration/secrets/${SEED.secretKey}`);
      await expect(page.getByRole('heading', { level: 1, name: SEED.secretKey })).toBeVisible();
      await expect(page.getByText('The stored value is never shown. Type a new value to replace it.')).toBeVisible();
      expect.soft(await page.locator('main').innerText(), 'the value on the page').not.toContain(SEED.secretValue);
      logResult(`RBAC-SEC-MASK [${role(key).label}]`, {
        scenario: `${role(key).label} reads the secret ${SEED.secretKey}`,
        actions: ['GET the list and the secret', 'Open the secret page'],
        expected: 'Only the key; the value appears nowhere',
        actual: 'Value not found in the API answers or on the page',
      });
    });
  }

  // ===============================================================================================
  // Connector profiles (HTTP)
  // ===============================================================================================
  const PROFILE_WRITERS: RoleKey[] = ['superAdmin', 'tenantAdmin', 'integrator'];

  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'integrator', 'submitter'] as RoleKey[]) {
    const page_ = key !== 'submitter';
    test(`RBAC-PROF-VIEW [${role(key).label}]: ${page_ ? 'Sees' : 'Reads (API only)'} the HTTP connector profiles`, async ({ page }) => {
      // Super Admin with All tenants: every tenant's profiles are listed (decision TC-312).
      await signInAs(page, role(key));
      const api = await backendFetch(page, '/v1.0/m8flow/connector-profiles?connector_type=http');
      expect.soft(api.status, 'GET connector-profiles').toBe(200);
      if (page_) {
        await page.goto(PROFILES_PATH);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(row(page, SEED.profileDisplay), 'the seeded profile is listed').toBeVisible();
      } else {
        expect((await pageRefused(page, PROFILES_PATH)).refused, 'the profiles page is refused').toBe(true);
        await expect(row(page, SEED.profileDisplay)).toHaveCount(0);
      }
      logResult(`RBAC-PROF-VIEW [${role(key).label}]`, {
        scenario: `${role(key).label} opens the HTTP profiles${key === 'superAdmin' ? ' (All tenants)' : ''}`,
        actions: [`Open ${PROFILES_PATH}`, 'GET connector-profiles'],
        expected: page_ ? `"${SEED.profileDisplay}" listed; API 200` : 'Page refused; API 200 (read for Service Tasks)',
        actual: `API ${api.status}`,
      });
    });
  }

  for (const key of PROFILE_WRITERS) {
    test(`RBAC-PROF-WRITE [${role(key).label}]: Adds, edits, deactivates and deletes a profile`, async ({ page, browser }) => {
      const display = `E2E RBAC ${key} ${stamp}`;
      const renamed = `${display} edited`;
      await enter(page, key);
      await page.goto(PROFILES_PATH);
      await page.getByRole('link', { name: 'Add profile', exact: true }).click();
      await page.getByTestId('connector-profile-display-name').fill(display);
      await page.getByTestId('connector-profile-field-basic_auth_username').fill('rbac-user');
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect(row(page, display)).toBeVisible();

      await row(page, display).getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByTestId('connector-profile-display-name').fill(renamed);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(row(page, renamed)).toBeVisible();

      await row(page, renamed).getByRole('button', { name: 'Deactivate', exact: true }).click();
      await expect(row(page, renamed).getByRole('button', { name: 'Reactivate', exact: true })).toBeVisible();
      await row(page, renamed).getByRole('button', { name: 'Reactivate', exact: true }).click();
      await expect(row(page, renamed).getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible();

      await row(page, renamed).getByRole('button', { name: 'Delete', exact: true }).click();
      await confirmDialog(page, 'Delete this profile permanently?').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row(page, renamed)).toHaveCount(0);
      const left = await asAdmin(browser, async (a) => (await listProfiles(a)).filter((p) => p.display_name === renamed).length);
      expect(left, 'the profile is deleted').toBe(0);
      await leave(page, key);
      logResult(`RBAC-PROF-WRITE [${role(key).label}]`, {
        scenario: `${role(key).label} manages an HTTP profile${key === 'superAdmin' ? ' (m8flow selected)' : ''}`,
        actions: ['Add profile -> Display name, username -> Save profile', 'Edit -> new name -> Save changes', 'Deactivate, Reactivate', 'Delete -> Delete'],
        expected: 'Added, renamed, deactivated and reactivated, deleted',
        actual: `"${display}" managed and deleted`,
      });
    });
  }

  for (const key of ['editor', 'viewer', 'submitter'] as RoleKey[]) {
    test(`RBAC-PROF-DENIED [${role(key).label}]: Cannot add, edit, deactivate or delete a profile`, async ({ page, browser }) => {
      await signInAs(page, role(key));
      if (key !== 'submitter') {
        await page.goto(PROFILES_PATH);
        await expect(row(page, SEED.profileDisplay)).toBeVisible();
        await expect.soft(page.getByRole('link', { name: 'Add profile', exact: true }), 'Add profile').toHaveCount(0);
        for (const action of ['Edit', 'Deactivate', 'Delete']) {
          await expect.soft(row(page, SEED.profileDisplay).getByRole('button', { name: action, exact: true }), action).toHaveCount(0);
        }
        await page.goto(`${PROFILES_PATH}/new`);
        await expect.soft(page.getByText('Not allowed', { exact: true }), 'add page refused').toBeVisible();
        await expect.soft(page.getByTestId('connector-profile-display-name'), 'profile form').toHaveCount(0);
      }
      const item = `/v1.0/m8flow/connector-profiles/${seeded.profileId}`;
      const post = (await backendFetch(page, '/v1.0/m8flow/connector-profiles', {
        method: 'POST',
        data: { connector_type: 'http', profile_name: `e2e-denied-${stamp}`, display_name: `E2E denied ${stamp}` },
      })).status;
      const put = (await backendFetch(page, item, { method: 'PUT', data: { display_name: 'changed' } })).status;
      const deactivate = (await backendFetch(page, item, { method: 'DELETE' })).status;
      const remove = (await backendFetch(page, `${item}?hard=true`, { method: 'DELETE' })).status;
      expect.soft(post, 'create through the API').toBe(403);
      expect.soft(put, 'edit through the API').toBe(403);
      expect.soft(deactivate, 'deactivate through the API').toBe(403);
      expect.soft(remove, 'delete through the API').toBe(403);
      const seed = await asAdmin(browser, async (a) => (await listProfiles(a)).find((p) => p.id === seeded.profileId));
      expect(seed?.display_name, 'the profile is unchanged').toBe(SEED.profileDisplay);
      expect(seed?.is_active, 'the profile is still active').toBe(true);
      logResult(`RBAC-PROF-DENIED [${role(key).label}]`, {
        scenario: `${role(key).label} and the HTTP profile "${SEED.profileDisplay}"`,
        actions: [...(key !== 'submitter' ? ['Look for Add profile / Edit / Deactivate / Delete', 'Open the add page'] : []), 'POST, PUT, DELETE through the API'],
        expected: 'Read-only: no buttons, add page "Not allowed"; API 403 for all; the profile is unchanged',
        actual: `POST ${post}, PUT ${put}, deactivate ${deactivate}, delete ${remove}; unchanged`,
      });
    });
  }

  for (const key of ['tenantAdmin', 'editor', 'viewer'] as RoleKey[]) {
    test(`RBAC-PROF-MASK [${role(key).label}]: A profile's password is never shown or returned`, async ({ page }) => {
      await signInAs(page, role(key));
      const list = JSON.stringify((await backendFetch(page, '/v1.0/m8flow/connector-profiles?connector_type=http')).body ?? '');
      const item = JSON.stringify((await backendFetch(page, `/v1.0/m8flow/connector-profiles/${seeded.profileId}`)).body ?? '');
      expect.soft(list.includes(SEED.profilePassword), 'the password in the list API').toBe(false);
      expect.soft(item.includes(SEED.profilePassword), 'the password in the item API').toBe(false);
      await page.goto(PROFILES_PATH);
      await expect(row(page, SEED.profileDisplay)).toBeVisible();
      expect.soft(await page.locator('main').innerText(), 'the password on the list page').not.toContain(SEED.profilePassword);
      if (key === 'tenantAdmin') {
        await page.goto(`${PROFILES_PATH}/${seeded.profileId}/edit`);
        // The saved password is not loaded into the form: only a "Replace" button.
        await expect(page.getByText('Passwords and tokens are never shown after saving. Use Replace to change one.')).toBeVisible();
        await expect.soft(page.getByRole('button', { name: 'Replace basic auth password', exact: true }), 'Replace button').toBeVisible();
        const values = await page.locator('main input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
        expect.soft(values.filter((v) => v.includes(SEED.profilePassword)), 'the password in a form field').toEqual([]);
        expect.soft(await page.locator('main').innerText(), 'the password on the edit page').not.toContain(SEED.profilePassword);
      }
      logResult(`RBAC-PROF-MASK [${role(key).label}]`, {
        scenario: `${role(key).label} reads the HTTP profile "${SEED.profileDisplay}"`,
        actions: ['GET the list and the profile', 'Open the profiles page', ...(key === 'tenantAdmin' ? ['Open Edit'] : [])],
        expected: 'The password appears nowhere; on Edit only "Replace basic auth password" is offered',
        actual: 'Password not found',
      });
    });
  }

  test('RBAC-PROF-SA: Super Admin saves a profile in the selected tenant only', async ({ page, browser }) => {
    const display = `E2E RBAC SA tenant ${stamp}`;
    await enter(page, 'superAdmin');
    await page.goto(PROFILES_PATH);
    await page.getByRole('link', { name: 'Add profile', exact: true }).click();
    await page.getByTestId('connector-profile-display-name').fill(display);
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(row(page, display)).toBeVisible();

    await selectTenantAsSuperAdmin(page, PARITY_SECOND_TENANT_SLUG);
    await page.goto(PROFILES_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/Loading profiles/)).toHaveCount(0);
    await expect.soft(row(page, display), 'listed in the second tenant').toHaveCount(0);

    const inM8flow = await asAdmin(browser, async (a) => (await listProfiles(a)).some((p) => p.display_name === display));
    const second = await withPage(browser, role('superAdmin').persona(), async (sa) => {
      const tenant = await getTenantBySlug(sa, PARITY_SECOND_TENANT_SLUG);
      return (await listProfiles(sa, tenant.id)).some((p) => p.display_name === display);
    }, 'platformAdmin');
    expect(inM8flow, 'saved in m8flow').toBe(true);
    expect(second, 'not saved in the second tenant').toBe(false);
    await leave(page, 'superAdmin');
    logResult('RBAC-PROF-SA', {
      scenario: 'Super Admin adds an HTTP profile with m8flow selected',
      actions: ['Select m8flow -> Add profile -> Save profile', `Select ${PARITY_SECOND_TENANT_SLUG}`, 'Check both tenants'],
      expected: 'Listed in m8flow; not in the second tenant',
      actual: `m8flow: ${inM8flow}; second tenant: ${second}`,
    });
  });

  // ===============================================================================================
  // API keys
  // ===============================================================================================
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'integrator', 'submitter'] as RoleKey[]) {
    const allowed = key === 'superAdmin' || key === 'tenantAdmin';
    test(`RBAC-KEY-VIEW [${role(key).label}]: ${allowed ? 'Sees' : 'Cannot see'} the API keys`, async ({ page }) => {
      await signInAs(page, role(key));
      let allTenants = 'n/a';
      if (key === 'superAdmin') {
        // All tenants: asked to pick one (decision TC-320), then the tenant's keys.
        await page.goto('/api-keys');
        await expect(page.getByText('Choose a tenant', { exact: true })).toBeVisible();
        allTenants = '"Choose a tenant"';
        await selectTenantAsSuperAdmin(page, SEED_TENANT_SLUG);
      }
      const api = await listKeys(page);
      await page.goto('/api-keys');
      if (allowed) {
        await expect(page.getByRole('heading', { level: 1, name: 'API Keys', exact: true })).toBeVisible();
        await expect(row(page, SEED.keyLabel), 'the seeded key is listed').toBeVisible();
        if (key === 'tenantAdmin') expect(api.status, 'GET nats-tokens').toBe(200);
      } else {
        await expect(row(page, SEED.keyLabel)).toHaveCount(0);
        expect(api.status, 'GET nats-tokens').toBe(403);
      }
      await leave(page, key);
      logResult(`RBAC-KEY-VIEW [${role(key).label}]`, {
        scenario: `${role(key).label} opens API Keys`,
        actions: [...(key === 'superAdmin' ? ['Open with All tenants', 'Select m8flow'] : []), 'Open /api-keys', 'GET nats-tokens'],
        expected: allowed ? `${key === 'superAdmin' ? 'All tenants: "Choose a tenant"; ' : ''}"${SEED.keyLabel}" listed` : 'No keys; API 403',
        actual: `All tenants: ${allTenants}; API ${api.status}`,
      });
    });
  }

  test('RBAC-KEY-MANAGE: Tenant Admin creates a key (shown once) and revokes it', async ({ page }) => {
    const label = `E2E RBAC created ${stamp}`;
    await signInAs(page, role('tenantAdmin'));
    await page.goto('/api-keys');
    await page.getByRole('button', { name: 'Create API key', exact: true }).first().click();
    await page.getByTestId('api-key-label').fill(label);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const tokenBox = page.getByTestId('api-key-token');
    await expect(tokenBox).toBeVisible();
    const token = (await tokenBox.innerText()).trim();
    expect(token.length, 'the full key is shown').toBeGreaterThan(10);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(row(page, label)).toBeVisible();
    const after = await listKeys(page);
    const createdKey = after.keys.find((k) => k.label === label);
    if (createdKey) created.keys.push(createdKey.id);
    expect.soft(after.raw.includes(token), 'the key in the list API').toBe(false);
    await page.reload();
    expect.soft(await page.locator('main').innerText(), 'the key on the page after Done').not.toContain(token);

    await row(page, label).getByRole('button', { name: 'Revoke', exact: true }).click();
    await confirmDialog(page, 'Revoke API key?').getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(row(page, label)).toContainText('Revoked');
    logResult('RBAC-KEY-MANAGE', {
      scenario: 'Tenant Admin creates and revokes an API key',
      actions: ['Create API key -> Name -> Create', 'Copy the key -> Done', 'Reload', 'Revoke -> Revoke'],
      expected: 'The full key is shown once; afterwards only its name; status Revoked',
      actual: `Key shown once (${token.length} characters), not returned or shown later; revoked`,
    });
  });

  test('RBAC-KEY-SA: Super Admin can view API keys but cannot create or revoke them', async ({ page, browser }) => {
    await enter(page, 'superAdmin');
    await page.goto('/api-keys');
    await expect(row(page, SEED.keyLabel)).toBeVisible();
    await expect.soft(page.getByRole('button', { name: 'Create API key', exact: true }), 'Create API key').toHaveCount(0);
    await expect.soft(row(page, SEED.keyLabel).getByRole('button', { name: 'Revoke', exact: true }), 'Revoke').toHaveCount(0);
    const tenant = await getTenantBySlug(page, SEED_TENANT_SLUG);
    const q = `?tenantId=${encodeURIComponent(tenant.id)}`;
    const post = (await backendFetch(page, `/v1.0/m8flow/nats-tokens${q}`, { method: 'POST', data: { label: `E2E SA ${stamp}`, expiresInDays: 30 } })).status;
    const del = (await backendFetch(page, `/v1.0/m8flow/nats-tokens/${encodeURIComponent(seeded.keyId)}${q}`, { method: 'DELETE' })).status;
    expect.soft(post, 'create through the API').toBe(403);
    expect.soft(del, 'revoke through the API').toBe(403);
    const seed = await asAdmin(browser, async (a) => (await listKeys(a)).keys.find((k) => k.id === seeded.keyId));
    expect(seed?.revokedAtInSeconds ?? null, 'the key is still active').toBeNull();
    await leave(page, 'superAdmin');
    logResult('RBAC-KEY-SA', {
      scenario: 'Super Admin on API Keys with m8flow selected',
      actions: ['Look for Create API key / Revoke', 'POST and DELETE through the API'],
      expected: 'Keys listed; no Create or Revoke; API 403; the key stays active',
      actual: `POST ${post}, DELETE ${del}; still active`,
    });
  });

  test('RBAC-KEY-DENIED: Editor, Viewer, Integrator and Submitter cannot create or revoke API keys', async ({ browser }) => {
    const rows: string[] = [];
    for (const key of ['editor', 'viewer', 'integrator', 'submitter'] as RoleKey[]) {
      const r = await withPage(browser, role(key).persona(), async (p) => ({
        post: (await backendFetch(p, '/v1.0/m8flow/nats-tokens', { method: 'POST', data: { label: `E2E denied ${stamp}`, expiresInDays: 30 } })).status,
        del: (await backendFetch(p, `/v1.0/m8flow/nats-tokens/${encodeURIComponent(seeded.keyId)}`, { method: 'DELETE' })).status,
      }));
      expect.soft(r.post, `${role(key).label}: create`).toBe(403);
      expect.soft(r.del, `${role(key).label}: revoke`).toBe(403);
      rows.push(`${role(key).label}: POST ${r.post}, DELETE ${r.del}`);
    }
    const seed = await asAdmin(browser, async (a) => (await listKeys(a)).keys.find((k) => k.id === seeded.keyId));
    expect(seed?.revokedAtInSeconds ?? null, 'the key is still active').toBeNull();
    logResult('RBAC-KEY-DENIED', {
      scenario: 'Roles without API Keys try to create and revoke a key',
      actions: ['POST and DELETE nats-tokens as each role'],
      expected: 'API 403 for all; the key stays active',
      actual: rows.join('; '),
    });
  });
});
