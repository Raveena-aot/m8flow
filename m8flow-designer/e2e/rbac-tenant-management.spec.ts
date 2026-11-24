import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  editorCredentials,
  signInAsSharedRealmUser,
  submitterCredentials,
  superAdminCredentials,
  tenantAdminCredentials,
  type DesignerPersona,
} from './helpers/auth';
import {
  addTenantMember,
  assignTenantGroupMember,
  backendFetch,
  deleteKeycloakUser,
  ensureKeycloakUser,
  ensureTenantGroup,
  findTenantGroup,
  getTenantBySlug,
  removeTenantMember,
} from './helpers/backendApi';
import { PARITY_SECOND_TENANT_SLUG, SEED_TENANT_SLUG } from './helpers/fixtures';
import { newStamp } from './helpers/mockCatalog';
import { closeRolePages, withPage } from './helpers/processFlow';
import { logResult } from './helpers/processesPage';
import { EXPECTED_MENUS, ROLES, pageRefused, permissionsCheck, role, signInAs, visibleMenus, type RoleKey } from './helpers/rbac';
import { seedBaselineOnce } from './seed/seed';

/**
 * RBAC: Tenant Management (members, groups, invitations, tenant registry) and groups that grant
 * permissions.
 *
 * Tenant m8flow, seeded users:
 * RBAC-TM-ACCESS   who can open Tenant Management, the members and the tenant registry; Invite
 *                  is offered to the Super Admin only (TC-180, 181, 196, 197, 310, 328, 329)
 * RBAC-TM-MANAGE   Tenant Admin and Super Admin add a group with a role, rename it, change its
 *                  roles, add a user to the tenant and the group, take them out, remove them and
 *                  delete the group (TC-182, 184, 186, 188, 190, 192)
 * RBAC-TM-DENIED   other roles cannot change members, groups, roles or tenants, nor add themselves
 *                  to a group (TC-183, 185, 187, 189, 191, 193, 199, 274)
 * RBAC-TM-SUPER    the Tenant Admin cannot give a group the super-admin role (TC-273)
 *
 * Second tenant, users created by the test and deleted afterwards (e2e-admin: tenant admin through
 * a group; e2e-editor: a member with no group):
 * RBAC-NEWGRP-351  a member with no group has no tenant menus or access
 * RBAC-NEWGRP-352  the tenant admin creates a group with the editor role and adds the member (UI)
 * RBAC-NEWGRP-353  after the next login the member has the editor menus and can create (UI + API)
 * RBAC-NEWGRP-354  the group's role is changed to viewer: after the next login only viewer access
 * RBAC-NEWGRP-355  the member is taken out of the group: after the next login no tenant access
 * RBAC-NEWGRP-356  the group is deleted
 * (TC-267, 268, 269, 271 are covered by 351..355.)
 */

const stamp = newStamp();
const tenantIds = { m8flow: '', second: '' };

const asSuperAdmin = <T>(browser: Browser, fn: (p: Page) => Promise<T>) =>
  withPage(browser, superAdminCredentials(), fn, 'platformAdmin');
const asTenantAdmin = <T>(browser: Browser, fn: (p: Page) => Promise<T>) => withPage(browser, tenantAdminCredentials(), fn);

const tenantPath = (tenantId: string, suffix = '') => `/v1.0/m8flow/tenants/${encodeURIComponent(tenantId)}${suffix}`;

/** Opens Tenant Management: the Tenant Admin's own tenant, or the Super Admin's chosen tenant. */
async function openTenantManagement(page: Page, superAdmin: boolean, tenantId: string): Promise<void> {
  await page.goto(superAdmin ? `/tenant-management/${encodeURIComponent(tenantId)}` : '/tenant-management');
  await expect(page.getByRole('tab', { name: /^Users/ })).toBeVisible();
}

async function openTab(page: Page, name: 'Users' | 'Groups'): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}

/** Group names in the tenant (as the Super Admin). */
async function groupExists(browser: Browser, tenantId: string, name: string): Promise<boolean> {
  return asSuperAdmin(browser, async (sa) => Boolean(await findTenantGroup(sa, tenantId, name)));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(480_000);
  await seedBaselineOnce(browser);
  await asSuperAdmin(browser, async (sa) => {
    tenantIds.m8flow = (await getTenantBySlug(sa, SEED_TENANT_SLUG)).id;
    tenantIds.second = (await getTenantBySlug(sa, PARITY_SECOND_TENANT_SLUG)).id;
  });
});

test.afterAll(async () => {
  await closeRolePages();
});

test.describe('RBAC: Tenant Management per role', { tag: ['@rbac', '@permissions'] }, () => {
  // ---------------------------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------------------------
  for (const r of ROLES) {
    const admin = r.key === 'tenantAdmin' || r.key === 'superAdmin';
    test(`RBAC-TM-ACCESS [${r.label}]: ${admin ? 'Opens' : 'Cannot open'} Tenant Management`, async ({ page }) => {
      await signInAs(page, r);
      const members = (await backendFetch(page, tenantPath(tenantIds.m8flow, '/members?limit=1'))).status;
      const registry = (await backendFetch(page, '/v1.0/m8flow/tenants')).status;
      const results: string[] = [`members API ${members}`, `tenant registry API ${registry}`];

      if (r.key === 'superAdmin') {
        // Tenants: the registry with Add tenant; each tenant opens its members, groups and invitations.
        await page.goto('/tenants');
        await expect(page.getByTestId('tenant-add-button'), 'Add tenant').toBeVisible();
        await openTenantManagement(page, true, tenantIds.m8flow);
        await expect(page.getByRole('tab', { name: /^Groups/ })).toBeVisible();
        await expect(page.getByRole('tab', { name: /^Pending invites/ }), 'Pending invites tab').toBeVisible();
        await expect(page.getByTestId('tenant-invite-user-button'), 'Invite User (not used)').toBeVisible();
        await page.getByTestId('tenant-member-search-input').fill(editorCredentials().username);
        await expect(page.getByTestId(`tenant-member-manage-groups-button-${editorCredentials().username}`)).toBeVisible();
        await openTab(page, 'Groups');
        await expect(page.getByTestId('tenant-group-add-button')).toBeVisible();
        expect(members, 'GET members').toBe(200);
        expect(registry, 'GET tenants').toBe(200);
        results.push('Tenants, members, groups and Invite User shown');
      } else if (r.key === 'tenantAdmin') {
        await openTenantManagement(page, false, tenantIds.m8flow);
        await expect(page.getByRole('tab', { name: /^Groups/ })).toBeVisible();
        await page.getByTestId('tenant-member-search-input').fill(editorCredentials().username);
        await expect(page.getByTestId(`tenant-member-manage-groups-button-${editorCredentials().username}`)).toBeVisible();
        await expect.soft(page.getByTestId('tenant-invite-user-button'), 'Invite User').toHaveCount(0);
        await expect.soft(page.getByRole('tab', { name: /^Pending invites/ }), 'Pending invites tab').toHaveCount(0);
        expect(members, 'GET members').toBe(200);
        expect([403, 404], 'GET tenants (registry)').toContain(registry);
        expect.soft((await pageRefused(page, '/tenants')).refused, 'Tenants page').toBe(true);
        const invite = (await backendFetch(page, tenantPath(tenantIds.m8flow, '/invitations'), {
          method: 'POST',
          data: { email: `e2e-rbac-invite-${stamp}@example.test`, roles: ['viewer'] },
        })).status;
        expect.soft(invite, 'create an invitation through the API').toBe(403);
        results.push(`members and groups shown; no Invite User; invite API ${invite}`);
      } else {
        expect((await pageRefused(page, '/tenant-management')).refused, 'Tenant Management page').toBe(true);
        expect([403, 404], 'GET members').toContain(members);
        expect([403, 404], 'GET tenants (registry)').toContain(registry);
        results.push('page refused');
      }
      logResult(`RBAC-TM-ACCESS [${r.label}]`, {
        scenario: `${r.label} and Tenant Management${r.key === 'superAdmin' ? ' (from Tenants, tenant m8flow)' : ''}`,
        actions: ['Open Tenant Management (Super Admin: Tenants -> m8flow)', 'Find a member', 'GET members and the tenant registry'],
        expected:
          r.key === 'superAdmin'
            ? 'Tenants with Add tenant; Users, Groups and Pending invites; Invite User shown; APIs 200'
            : r.key === 'tenantAdmin'
              ? 'Users and Groups; no Invite User or Pending invites; no tenant registry; invite API 403'
              : 'Page refused; APIs 403 / 404',
        actual: results.join('; '),
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Manage members and groups in the UI
  // ---------------------------------------------------------------------------------------------
  for (const key of ['tenantAdmin', 'superAdmin'] as RoleKey[]) {
    test(`RBAC-TM-MANAGE [${role(key).label}]: Manages a group and a member`, async ({ page, browser }) => {
      test.setTimeout(240_000);
      const superAdmin = key === 'superAdmin';
      const tag = superAdmin ? 'SA' : 'TA';
      const group = `E2E RBAC TM ${tag} ${stamp}`;
      const renamed = `${group} R`;
      // A shared-realm user who is not in m8flow (a second-tenant test user).
      const outsider = 'e2e-t2-reviewer';
      try {
        await signInAs(page, role(key));
        await openTenantManagement(page, superAdmin, tenantIds.m8flow);

        // Add a group with the viewer role.
        await openTab(page, 'Groups');
        await page.getByTestId('tenant-group-add-button').click();
        await page.getByTestId('tenant-group-name-input').fill(group);
        await page.getByTestId('tenant-group-create-role-checkbox-viewer').click();
        await page.getByTestId('tenant-group-submit-button').click();
        await expect(page.getByTestId(`tenant-group-rename-button-${group}`)).toBeVisible();
        expect((await asSuperAdmin(browser, (sa) => findTenantGroup(sa, tenantIds.m8flow, group)))?.mapped_roles, 'roles after create').toEqual(['viewer']);

        // Rename it.
        await page.getByTestId(`tenant-group-rename-button-${group}`).click();
        await page.getByTestId('tenant-group-rename-input').fill(renamed);
        await page.getByTestId('tenant-group-rename-submit-button').click();
        await expect(page.getByTestId(`tenant-group-rename-button-${renamed}`)).toBeVisible();

        // Roles: add editor.
        await page.getByTestId(`tenant-group-manage-roles-button-${renamed}`).click();
        await page.getByTestId(`tenant-group-role-checkbox-${renamed}-editor`).click();
        await page.getByTestId('tenant-group-roles-save').click();
        await expect
          .poll(async () => ((await asSuperAdmin(browser, (sa) => findTenantGroup(sa, tenantIds.m8flow, renamed)))?.mapped_roles ?? []).sort(), {
            message: 'roles after the change',
          })
          .toEqual(['editor', 'viewer']);

        // Add an existing user to the tenant and the group.
        await openTab(page, 'Users');
        await page.getByTestId('tenant-member-add-button').click();
        await page.getByLabel('Search available users').fill(outsider);
        await page.getByRole('radio', { name: new RegExp(outsider) }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByTestId(`tenant-add-member-group-${renamed}`).click();
        await page.getByTestId('tenant-member-add-submit').click();
        await page.getByTestId('tenant-member-search-input').fill(outsider);
        await expect(page.getByTestId(`tenant-member-group-chip-${outsider}-${renamed}`)).toBeVisible();

        // Take them out of the group.
        await page.getByTestId(`tenant-member-manage-groups-button-${outsider}`).click();
        await page.getByTestId(`tenant-member-group-toggle-${renamed}`).click();
        await page.getByTestId('tenant-member-groups-save').click();
        await expect(page.getByTestId(`tenant-member-group-chip-${outsider}-${renamed}`)).toHaveCount(0);

        // Remove them from the tenant.
        await page.getByTestId(`tenant-member-remove-button-${outsider}`).click();
        await page.getByRole('alertdialog', { name: 'Remove member' }).or(page.getByRole('dialog', { name: 'Remove member' }))
          .getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(page.getByTestId(`tenant-member-remove-button-${outsider}`)).toHaveCount(0);

        // Delete the group.
        await openTab(page, 'Groups');
        await page.getByTestId(`tenant-group-remove-button-${renamed}`).click();
        await page.getByRole('alertdialog', { name: 'Delete group' }).or(page.getByRole('dialog', { name: 'Delete group' }))
          .getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(page.getByTestId(`tenant-group-rename-button-${renamed}`)).toHaveCount(0);
        expect(await groupExists(browser, tenantIds.m8flow, renamed), 'the group is deleted').toBe(false);
      } finally {
        await asSuperAdmin(browser, async (sa) => {
          await removeTenantMember(sa, tenantIds.m8flow, outsider).catch(() => false);
          for (const name of [group, renamed]) {
            await backendFetch(sa, tenantPath(tenantIds.m8flow, `/groups/${encodeURIComponent(name)}`), { method: 'DELETE' }).catch(() => null);
          }
        });
      }
      logResult(`RBAC-TM-MANAGE [${role(key).label}]`, {
        scenario: `${role(key).label} manages groups and members of m8flow`,
        actions: [
          'Groups -> Add Group with viewer -> Create',
          'Rename',
          'Roles -> add editor -> Save',
          `Users -> Add Member ${outsider} into the group`,
          'Groups of the member -> take out -> Save',
          'Remove the member',
          'Delete the group',
        ],
        expected: 'Each change is shown and saved; the user and the group are gone at the end',
        actual: 'Done',
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Other roles: no changes through the API
  // ---------------------------------------------------------------------------------------------
  for (const key of ['editor', 'viewer', 'integrator', 'submitter', 'reviewer'] as RoleKey[]) {
    test(`RBAC-TM-DENIED [${role(key).label}]: Cannot change members, groups, roles or tenants`, async ({ page, browser }) => {
      const me = role(key).persona().username;
      const group = `E2E RBAC Denied ${stamp}`;
      await signInAs(page, role(key));
      const t = tenantIds.m8flow;
      const calls: Record<string, number> = {
        'add member': (await backendFetch(page, tenantPath(t, '/members'), { method: 'POST', data: { username: 'e2e-t2-editor', group_names: [] } })).status,
        'remove member': (await backendFetch(page, tenantPath(t, `/members/${encodeURIComponent(submitterCredentials().username)}`), { method: 'DELETE' })).status,
        'create group': (await backendFetch(page, tenantPath(t, '/groups'), { method: 'POST', data: { name: group, roles: ['tenant-admin'] } })).status,
        'add myself to Designers': (await backendFetch(page, tenantPath(t, `/groups/Designers/members/${encodeURIComponent(me)}`), { method: 'PUT' })).status,
        'give Designers tenant-admin': (await backendFetch(page, tenantPath(t, '/groups/Designers/roles/tenant-admin'), { method: 'PUT' })).status,
        'create tenant': (await backendFetch(page, '/v1.0/m8flow/tenant-realms', { method: 'POST', data: { slug: `e2e-rbac-${stamp}`.toLowerCase(), name: `E2E RBAC ${stamp}` } })).status,
      };
      for (const [name, status] of Object.entries(calls)) expect.soft([403, 404], name).toContain(status);

      const after = await asSuperAdmin(browser, async (sa) => ({
        group: Boolean(await findTenantGroup(sa, t, group)),
        designers: (await findTenantGroup(sa, t, 'Designers'))?.mapped_roles ?? [],
        submitter: (await backendFetch(sa, tenantPath(t, `/members?search=${encodeURIComponent(submitterCredentials().username)}`))).body,
      }));
      expect.soft(after.group, 'no group was created').toBe(false);
      expect.soft(after.designers, 'Designers did not get tenant-admin').not.toContain('tenant-admin');
      expect.soft(JSON.stringify(after.submitter), 'the submitter is still a member').toContain(submitterCredentials().username);
      if (after.group) await asSuperAdmin(browser, (sa) => backendFetch(sa, tenantPath(t, `/groups/${encodeURIComponent(group)}`), { method: 'DELETE' }));
      logResult(`RBAC-TM-DENIED [${role(key).label}]`, {
        scenario: `${role(key).label} tries tenant changes through the API`,
        actions: Object.keys(calls),
        expected: '403 (or 404) for every call; nothing changes',
        actual: Object.entries(calls).map(([k, v]) => `${k} ${v}`).join('; '),
      });
    });
  }

  test('RBAC-TM-SUPER: Tenant Admin cannot give a group the super-admin role', async ({ page, browser }) => {
    const group = `E2E RBAC SuperRole ${stamp}`;
    await signInAs(page, role('tenantAdmin'));
    const t = tenantIds.m8flow;
    const create = (await backendFetch(page, tenantPath(t, '/groups'), { method: 'POST', data: { name: group, roles: ['super-admin'] } })).status;
    const grant = (await backendFetch(page, tenantPath(t, '/groups/Designers/roles/super-admin'), { method: 'PUT' })).status;
    expect.soft([400, 403], 'create a group with super-admin').toContain(create);
    expect.soft([400, 403], 'give Designers super-admin').toContain(grant);
    await openTenantManagement(page, false, t);
    await openTab(page, 'Groups');
    await page.getByTestId('tenant-group-add-button').click();
    await expect(page.getByTestId('tenant-group-create-role-checkbox-viewer')).toBeVisible();
    await expect.soft(page.getByTestId('tenant-group-create-role-checkbox-super-admin'), 'super-admin is not offered').toHaveCount(0);
    const after = await asSuperAdmin(browser, async (sa) => ({
      group: await findTenantGroup(sa, t, group),
      designers: (await findTenantGroup(sa, t, 'Designers'))?.mapped_roles ?? [],
    }));
    expect.soft(after.designers, 'Designers roles').not.toContain('super-admin');
    expect.soft(after.group?.mapped_roles ?? [], 'new group roles').not.toContain('super-admin');
    if (after.group) await asSuperAdmin(browser, (sa) => backendFetch(sa, tenantPath(t, `/groups/${encodeURIComponent(group)}`), { method: 'DELETE' }));
    logResult('RBAC-TM-SUPER', {
      scenario: 'Tenant Admin tries to grant super-admin',
      actions: ['POST a group with super-admin', 'PUT super-admin on Designers', 'Open Add Group'],
      expected: '400 / 403 for both; super-admin is not offered in Add Group; no group gets it',
      actual: `create ${create}, grant ${grant}`,
    });
  });
});

// =================================================================================================
// A new group grants permissions (second tenant, users created and deleted by the test)
// =================================================================================================
// In order (one worker); not serial, so one failing check does not skip the rest.
test.describe('RBAC: a new group grants and withdraws permissions', { tag: ['@rbac', '@permissions'] }, () => {
  const ADMIN: DesignerPersona = { username: 'e2e-admin', password: 'e2e-admin' };
  const MEMBER: DesignerPersona = { username: 'e2e-editor', password: 'e2e-editor' };
  const ADMIN_GROUP = 'E2E RBAC Admins';
  // A fixed name, and each test first puts the group in the state it starts from (through the API):
  // after a failure Playwright starts a new worker (new run stamp, setup and clean-up run again), so
  // a test cannot rely on what an earlier test did on screen.
  const group = 'E2E RBAC Designers';

  /** Puts the group in a known state: absent, or present with exactly `roles` and the member in or out. */
  async function groupState(browser: Browser, state: { exists: boolean; roles?: string[]; member?: boolean }): Promise<void> {
    await asSuperAdmin(browser, async (sa) => {
      const t = tenantIds.second;
      const path = tenantPath(t, `/groups/${encodeURIComponent(group)}`);
      if (!state.exists) {
        await backendFetch(sa, path, { method: 'DELETE' }).catch(() => null);
        return;
      }
      await addTenantMember(sa, t, MEMBER.username, []);
      await ensureTenantGroup(sa, t, group, state.roles ?? []);
      for (const r of (await findTenantGroup(sa, t, group))?.mapped_roles ?? []) {
        if (!(state.roles ?? []).includes(r)) await backendFetch(sa, `${path}/roles/${encodeURIComponent(r)}`, { method: 'DELETE' });
      }
      if (state.member) await assignTenantGroupMember(sa, t, group, MEMBER.username);
      else await backendFetch(sa, `${path}/members/${encodeURIComponent(MEMBER.username)}`, { method: 'DELETE' });
    });
  }
  const slug = PARITY_SECOND_TENANT_SLUG;

  const seedUser = (u: DesignerPersona) => ({
    username: u.username,
    password: u.password,
    email: `${u.username}@baseline.example.test`,
    firstName: 'E2E',
    lastName: `RBAC ${u.username}`,
  });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await asSuperAdmin(browser, async (sa) => {
      const t = tenantIds.second;
      for (const u of [ADMIN, MEMBER]) await ensureKeycloakUser(sa, seedUser(u));
      await ensureTenantGroup(sa, t, ADMIN_GROUP, ['tenant-admin']);
      await addTenantMember(sa, t, ADMIN.username, [ADMIN_GROUP]);
      await assignTenantGroupMember(sa, t, ADMIN_GROUP, ADMIN.username);
      await addTenantMember(sa, t, MEMBER.username, []);
    });
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await asSuperAdmin(browser, async (sa) => {
      const t = tenantIds.second;
      for (const name of [group, ADMIN_GROUP]) {
        await backendFetch(sa, tenantPath(t, `/groups/${encodeURIComponent(name)}`), { method: 'DELETE' }).catch(() => null);
      }
      for (const u of [ADMIN, MEMBER]) {
        await removeTenantMember(sa, t, u.username).catch(() => false);
        await deleteKeycloakUser(sa, u.username).catch(() => false);
      }
    }).finally(closeRolePages);
  });

  /**
   * Logs in as the member: its menus, whether the server lets it read process models (the
   * permission check the app uses; the list itself answers a refused user with an empty list),
   * and the answer to creating a process group.
   */
  async function memberAccess(page: Page): Promise<{ menus: string[]; read: boolean; create: number }> {
    await signInAsSharedRealmUser(page, MEMBER, slug);
    const menus = await visibleMenus(page);
    const read = Boolean((await permissionsCheck(page, [['/process-models', 'GET']]))['/process-models']?.GET);
    const id = `e2e-rbac-newgrp-${stamp}`.toLowerCase();
    const create = (await backendFetch(page, '/v1.0/m8flow/process-groups', {
      method: 'POST',
      data: { id, display_name: `E2E RBAC newgrp ${stamp}`, description: 'E2E mock data -- safe to delete' },
    })).status;
    if (create < 300) await backendFetch(page, `/v1.0/m8flow/process-groups/${id}`, { method: 'DELETE' });
    return { menus, read, create };
  }

  /** Logs in as the e2e tenant admin and opens its Tenant Management. */
  async function asE2eAdmin(page: Page): Promise<void> {
    await signInAsSharedRealmUser(page, ADMIN, slug);
    await openTenantManagement(page, false, tenantIds.second);
  }

  test('RBAC-NEWGRP-351: A member with no group has no tenant menus or access', async ({ page, browser }) => {
    await groupState(browser, { exists: false });
    const access = await memberAccess(page);
    expect.soft(access.menus, 'menus besides Home').toEqual([]);
    expect.soft(access.read, 'may read process models').toBe(false);
    expect.soft([403, 404], 'create a process group').toContain(access.create);
    logResult('RBAC-NEWGRP-351', {
      scenario: `${MEMBER.username}: member of ${slug}, in no group`,
      actions: ['Log in', 'Read the sidebar', 'Read and create through the API'],
      expected: 'Home only; API refused',
      actual: `menus: ${access.menus.join(', ') || 'Home only'}; read ${access.read}, create ${access.create}`,
    });
  });

  test('RBAC-NEWGRP-352: The tenant admin creates a group with the editor role and adds the member', async ({ page, browser }) => {
    await groupState(browser, { exists: false });
    await asE2eAdmin(page);
    await openTab(page, 'Groups');
    await page.getByTestId('tenant-group-add-button').click();
    await page.getByTestId('tenant-group-name-input').fill(group);
    await page.getByTestId('tenant-group-create-role-checkbox-editor').click();
    await page.getByTestId('tenant-group-submit-button').click();
    await expect(page.getByTestId(`tenant-group-rename-button-${group}`)).toBeVisible();

    await openTab(page, 'Users');
    await page.getByTestId('tenant-member-search-input').fill(MEMBER.username);
    await page.getByTestId(`tenant-member-manage-groups-button-${MEMBER.username}`).click();
    await page.getByTestId(`tenant-member-group-toggle-${group}`).click();
    await page.getByTestId('tenant-member-groups-save').click();
    await expect(page.getByTestId(`tenant-member-group-chip-${MEMBER.username}-${group}`)).toBeVisible();
    await expect(page.getByTestId(`tenant-member-role-chip-${MEMBER.username}-editor`), 'effective role editor').toBeVisible();

    const saved = await asSuperAdmin(browser, (sa) => findTenantGroup(sa, tenantIds.second, group));
    expect(saved?.mapped_roles, 'group roles').toEqual(['editor']);
    expect(saved?.members?.map((m) => m.username), 'group members').toContain(MEMBER.username);
    logResult('RBAC-NEWGRP-352', {
      scenario: `${ADMIN.username} (tenant admin of ${slug}) gives ${MEMBER.username} the editor role through a new group`,
      actions: [`Groups -> Add Group "${group}" with editor`, `Users -> ${MEMBER.username} -> Groups -> tick the group -> Save`],
      expected: 'Group created with editor; the member shows the group and the editor role',
      actual: `roles ${saved?.mapped_roles?.join(', ')}; members ${saved?.members?.map((m) => m.username).join(', ')}`,
    });
  });

  test('RBAC-NEWGRP-353: After the next login the member has the editor menus and can create', async ({ page, browser }) => {
    await groupState(browser, { exists: true, roles: ['editor'], member: true });
    const access = await memberAccess(page);
    expect.soft(access.menus.sort(), 'menus').toEqual([...EXPECTED_MENUS.editor].sort());
    expect.soft(access.read, 'may read process models').toBe(true);
    expect.soft(access.create, 'create a process group').toBeLessThan(300);
    await page.goto('/processes');
    await expect.soft(page.getByTestId('processes-new-group-button'), 'New process group').toBeVisible();
    logResult('RBAC-NEWGRP-353', {
      scenario: `${MEMBER.username} logs in after joining "${group}" (editor)`,
      actions: ['Log in', 'Read the sidebar', 'Create a process group through the API (then deleted)', 'Open Processes'],
      expected: `Editor menus (${EXPECTED_MENUS.editor.join(', ')}); create allowed; New process group shown`,
      actual: `menus: ${access.menus.join(', ')}; read ${access.read}, create ${access.create}`,
    });
  });

  test('RBAC-NEWGRP-354: The group is changed to viewer; after the next login only viewer access remains', async ({ page, browser }) => {
    await groupState(browser, { exists: true, roles: ['editor'], member: true });
    await asE2eAdmin(page);
    await openTab(page, 'Groups');
    await page.getByTestId(`tenant-group-manage-roles-button-${group}`).click();
    await page.getByTestId(`tenant-group-role-checkbox-${group}-editor`).click();
    await page.getByTestId(`tenant-group-role-checkbox-${group}-viewer`).click();
    await page.getByTestId('tenant-group-roles-save').click();
    await expect(page.getByTestId(`tenant-group-roles-save`)).toHaveCount(0);

    const access = await memberAccess(page);
    expect.soft(access.menus.sort(), 'menus').toEqual([...EXPECTED_MENUS.viewer].sort());
    expect.soft(access.read, 'may read process models').toBe(true);
    expect.soft([403, 404], 'create a process group').toContain(access.create);
    logResult('RBAC-NEWGRP-354', {
      scenario: `${ADMIN.username} changes "${group}" from editor to viewer; ${MEMBER.username} logs in again`,
      actions: ['Groups -> Roles -> untick editor, tick viewer -> Save', `Log in as ${MEMBER.username}`],
      expected: `Viewer menus (${EXPECTED_MENUS.viewer.join(', ')}); read allowed; create refused`,
      actual: `menus: ${access.menus.join(', ')}; read ${access.read}, create ${access.create}`,
    });
  });

  test('RBAC-NEWGRP-355: The member is taken out of the group; after the next login no tenant access', async ({ page, browser }) => {
    await groupState(browser, { exists: true, roles: ['viewer'], member: true });
    await asE2eAdmin(page);
    await page.getByTestId('tenant-member-search-input').fill(MEMBER.username);
    await page.getByTestId(`tenant-member-manage-groups-button-${MEMBER.username}`).click();
    await page.getByTestId(`tenant-member-group-toggle-${group}`).click();
    await page.getByTestId('tenant-member-groups-save').click();
    await expect(page.getByTestId(`tenant-member-group-chip-${MEMBER.username}-${group}`)).toHaveCount(0);

    const access = await memberAccess(page);
    expect.soft(access.menus, 'menus besides Home').toEqual([]);
    expect.soft(access.read, 'may read process models').toBe(false);
    expect.soft([403, 404], 'create a process group').toContain(access.create);
    logResult('RBAC-NEWGRP-355', {
      scenario: `${ADMIN.username} takes ${MEMBER.username} out of "${group}"; ${MEMBER.username} logs in again`,
      actions: ['Users -> Groups -> untick the group -> Save', `Log in as ${MEMBER.username}`],
      expected: 'Home only; API refused',
      actual: `menus: ${access.menus.join(', ') || 'Home only'}; read ${access.read}, create ${access.create}`,
    });
  });

  test('RBAC-NEWGRP-356: The tenant admin deletes the group', async ({ page, browser }) => {
    await groupState(browser, { exists: true, roles: ['viewer'], member: false });
    await asE2eAdmin(page);
    await openTab(page, 'Groups');
    await page.getByTestId(`tenant-group-remove-button-${group}`).click();
    await page.getByRole('alertdialog', { name: 'Delete group' }).or(page.getByRole('dialog', { name: 'Delete group' }))
      .getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId(`tenant-group-rename-button-${group}`)).toHaveCount(0);
    expect(await groupExists(browser, tenantIds.second, group), 'the group is deleted').toBe(false);
    logResult('RBAC-NEWGRP-356', {
      scenario: `${ADMIN.username} deletes "${group}"`,
      actions: ['Groups -> Delete -> Delete'],
      expected: 'The group is gone',
      actual: 'Deleted',
    });
  });
});
