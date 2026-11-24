import { expect, test, type Page } from '@playwright/test';

import { submitterCredentials, editorCredentials, tenantAdminCredentials, viewerCredentials } from './helpers/auth';
import { backendFetch } from './helpers/backendApi';
import { createMockGroup, deleteMockGroup } from './helpers/mockCatalog';
import {
  completeTask,
  completeTaskInUi,
  instanceAction,
  instanceRow,
  startInstance,
  useFlowCatalog,
  waitForStatus,
  withPage,
} from './helpers/processFlow';
import { closeMenu, logResult, menuItemLabels, modelRow } from './helpers/processesPage';
import { role, selectTenantAsSuperAdmin, signInAs, type RoleKey } from './helpers/rbac';


const flow = useFlowCatalog(test, 'rbacp', {
  request: { name: 'RBAC Request', template: 'flow-submit-then-approve' },
  approval: { name: 'RBAC Approval', template: 'flow-single-approval' },
});

/**
 * Instances by who started them (set in beforeAll). The Request model's first task goes to the
 * Submitters lane, so the submitter is assigned to every Request instance. adminApproval is an
 * Approval instance (Approvers lane) started by the tenant admin: the submitter, editor and
 * viewer neither started it nor are assigned to it.
 */
const started = { editor: 0, submitter: 0, tenantAdmin: 0, adminApproval: 0 };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  const route = flow.model('request').route;
  started.editor = await withPage(browser, editorCredentials(), (p) => startInstance(p, flow, route));
  started.submitter = await withPage(browser, submitterCredentials(), (p) => startInstance(p, flow, route));
  started.tenantAdmin = await withPage(browser, tenantAdminCredentials(), (p) => startInstance(p, flow, route));
  started.adminApproval = await withPage(browser, tenantAdminCredentials(), (p) => startInstance(p, flow, flow.model('approval').route));
});

const modelPath = () => `/v1.0/m8flow/process-models/${flow.model('request').route.split(':').map(encodeURIComponent).join(':')}`;

/** Signs in; the Super Admin then works inside tenant m8flow (writes need a selected tenant). */
async function enter(page: Page, key: RoleKey): Promise<void> {
  await signInAs(page, role(key));
  if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'm8flow');
}

type ListedInstance = { id: number; started_by_me?: boolean; assigned_to_me?: boolean; process_model_display_name?: string };

/**
 * The role's instance list (all pages up to 500 rows): every row, and the ids of this file's
 * instances among them.
 */
async function listedInstances(page: Page): Promise<{ status: number; rows: ListedInstance[]; ids: number[] }> {
  const rows: ListedInstance[] = [];
  let status = 0;
  for (let p = 1; p <= 5; p += 1) {
    const result = await backendFetch(page, `/v1.0/m8flow/process-instances?page=${p}&per_page=100`);
    status = result.status;
    if (status !== 200) break;
    const batch = (result.body as { results?: ListedInstance[] } | null)?.results ?? [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const ours = Object.values(started);
  return { status, rows, ids: rows.map((r) => r.id).filter((id) => ours.includes(id)).sort((a, b) => a - b) };
}

test.describe('RBAC: processes and process instances per role', { tag: ['@rbac', '@permissions'] }, () => {
  // ---------------------------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------------------------
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    test(`RBAC-PRC-VIEW [${role(key).label}]: Opens the process list and a model page`, async ({ page }) => {
      await signInAs(page, role(key));
      const m = flow.model('request');
      const api = (await backendFetch(page, modelPath())).status;
      expect(api, 'GET the model').toBe(200);
      await page.goto(`/processes/${m.route}`);
      await expect(page.getByRole('heading', { name: m.name, exact: true })).toBeVisible();
      logResult(`RBAC-PRC-VIEW [${role(key).label}]`, {
        scenario: `${role(key).label} opens a process model`,
        actions: ['Open the model page by its address', 'GET the model through the API'],
        expected: 'Model page shows its name; API 200',
        actual: `API ${api}; page shown`,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Create group / model
  // ---------------------------------------------------------------------------------------------
  for (const key of ['tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const allowed = key === 'tenantAdmin' || key === 'editor';
    test(`RBAC-PRC-CREATE [${role(key).label}]: ${allowed ? 'Can' : 'Cannot'} create a process group and model`, async ({ page }) => {
      await signInAs(page, role(key));
      await page.goto('/processes');
      await expect(page.getByRole('heading', { name: 'Processes', exact: true })).toBeVisible();
      await expect(page.getByText('Loading process models…')).toHaveCount(0);
      await expect.soft(page.getByTestId('processes-new-group-button'), 'New process group button').toHaveCount(allowed ? 1 : 0);
      await expect.soft(page.getByRole('button', { name: 'New process model', exact: true }), 'New process model button').toHaveCount(allowed ? 1 : 0);

      const groupId = `e2e-rbac-${key.toLowerCase()}-${flow.stamp}`;
      const group = await backendFetch(page, '/v1.0/m8flow/process-groups', {
        method: 'POST',
        data: { id: groupId, display_name: `E2E RBAC ${key} ${flow.stamp}`, description: 'E2E mock data -- safe to delete' },
      });
      if (group.status < 300) await deleteMockGroup(page, groupId);
      const model = await backendFetch(page, '/v1.0/m8flow/process-models', {
        method: 'POST',
        data: { group_id: flow.groupId, id: `e2e-rbac-model-${key.toLowerCase()}-${flow.stamp}`, display_name: `E2E RBAC model ${key}` },
      });
      if (model.status < 300) flow.track.models.push(`${flow.groupId}:e2e-rbac-model-${key.toLowerCase()}-${flow.stamp}`);
      if (allowed) {
        expect.soft(group.status, 'POST process group').toBeLessThan(300);
        expect.soft(model.status, 'POST process model').toBeLessThan(300);
      } else {
        expect.soft(group.status, 'POST process group').toBe(403);
        expect.soft(model.status, 'POST process model').toBe(403);
      }
      logResult(`RBAC-PRC-CREATE [${role(key).label}]`, {
        scenario: `${role(key).label} on the Processes page`,
        actions: ['Open Processes', 'Look for New process group / New process model', 'Create a group and a model through the API'],
        expected: allowed ? 'Both buttons shown; both created (then removed)' : 'Both buttons hidden; API 403 for both, nothing created',
        actual: `group ${group.status}, model ${model.status}`,
      });
    });
  }

  test('RBAC-PRC-CREATE [Super Admin]: Create is hidden with All tenants and shown with a tenant selected', async ({ page }) => {
    await signInAs(page, role('superAdmin'));
    await page.goto('/processes');
    await expect(page.getByRole('heading', { name: 'Processes', exact: true })).toBeVisible();
    await expect(page.getByText('Loading process models…')).toHaveCount(0);
    const newGroup = page.getByTestId('processes-new-group-button');
    const newModel = page.getByRole('button', { name: 'New process model', exact: true });
    await expect.soft(newGroup, 'New process group with All tenants').toHaveCount(0);
    await expect.soft(newModel, 'New process model with All tenants').toHaveCount(0);

    await selectTenantAsSuperAdmin(page, 'm8flow');
    await page.goto('/processes');
    await expect(page.getByText('Loading process models…')).toHaveCount(0);
    await expect.soft(newGroup, 'New process group with m8flow selected').toHaveCount(1);
    await expect.soft(newModel, 'New process model with m8flow selected').toHaveCount(1);
    await selectTenantAsSuperAdmin(page, 'All tenants');

    logResult('RBAC-PRC-CREATE [Super Admin]', {
      scenario: 'Super Admin on the Processes page, All tenants then m8flow',
      actions: ['Open Processes with All tenants', 'Select m8flow', 'Open Processes again'],
      expected: 'Create buttons hidden with All tenants; shown with a tenant selected',
      actual: 'As expected',
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Model page actions
  // ---------------------------------------------------------------------------------------------
  const MANAGE_ITEMS = ['Edit identity', 'Pause', 'Unpublish', 'Copy', 'Save as template'];
  // Save as template creates a template in a tenant: not offered to the Super Admin (by design).
  const manageItems = (key: RoleKey) => (key === 'superAdmin' ? MANAGE_ITEMS.filter((i) => i !== 'Save as template') : MANAGE_ITEMS);
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const manage = key === 'superAdmin' || key === 'tenantAdmin' || key === 'editor';
    const start = key !== 'viewer';
    const modeler = key !== 'submitter';
    test(`RBAC-PRC-MODEL [${role(key).label}]: The model page offers only the role's actions`, async ({ page }) => {
      await enter(page, key);
      const m = flow.model('request');
      await page.goto(`/processes/${m.route}`);
      await expect(page.getByRole('heading', { name: m.name, exact: true })).toBeVisible();
      await expect(page.getByTestId('process-model-status')).toContainText('Published');

      // Edit in modeler (header) for the roles that change the model; every role that reads the
      // model's files can open the diagram from the file list (Viewer: read-only).
      await expect.soft(page.getByRole('link', { name: /in modeler/ }), 'Edit in modeler').toHaveCount(manage ? 1 : 0);
      await expect.soft(page.locator('main a[href*="/modeler/"]').first(), 'open the diagram from the file list').toBeVisible({ visible: modeler });
      await expect.soft(page.getByRole('button', { name: 'Start process', exact: true }), 'Start process').toHaveCount(start ? 1 : 0);
      await expect.soft(page.getByRole('button', { name: 'Add file', exact: true }), 'Add file (upload / import BPMN)').toHaveCount(manage ? 1 : 0);
      // Export (Download file): every role that reads the model's files; the Submitter has no
      // file list, so no Download (decision TC-061, updated 17 Nov).
      await expect.soft(page.getByRole('button', { name: 'Download file' }).first(), 'Download file (export)').toBeVisible({ visible: modeler });

      const more = page.getByRole('button', { name: 'More actions', exact: true });
      let items: string[] = [];
      if (await more.count()) {
        await more.click();
        items = await menuItemLabels(page.getByRole('menu'));
        await closeMenu(page);
      }
      const offered = MANAGE_ITEMS.filter((i) => items.includes(i));
      expect.soft(offered, 'manage actions in More actions').toEqual(manage ? manageItems(key) : []);

      // Denied writes are refused by the API too (nothing changes).
      let writes = 'not tried (allowed role)';
      if (!manage) {
        const status = await backendFetch(page, modelPath(), { method: 'PUT', data: { status: 'paused' } });
        const rename = await backendFetch(page, modelPath(), { method: 'PUT', data: { display_name: `${m.name} renamed` } });
        expect.soft(status.status, 'unpublish (PUT status) through the API').toBe(403);
        expect.soft(rename.status, 'rename the model (PUT) through the API').toBe(403);
        writes = `PUT status ${status.status}, PUT name ${rename.status}`;
      }
      if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');

      logResult(`RBAC-PRC-MODEL [${role(key).label}]`, {
        scenario: `${role(key).label} on a published model page${key === 'superAdmin' ? ' (m8flow selected)' : ''}`,
        actions: ['Open the model page', 'Check modeler, Start, Add file, Download and More actions', 'Try the denied writes through the API'],
        expected: `Edit in modeler ${manage ? 'shown' : 'hidden'}; diagram from file list ${modeler ? 'shown' : 'hidden'}; Start ${start ? 'shown' : 'hidden'}; Download ${modeler ? 'shown' : 'hidden'}; Add file ${manage ? 'shown' : 'hidden'}; manage actions ${manage ? 'all' : 'none'}${manage ? '' : '; API writes 403'}`,
        actual: `More actions: ${items.join(', ') || 'none'}; ${writes}`,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------------------------
  // Tenant Admin and Super Admin see every instance. Everyone else sees only the instances they
  // started or that have a task assigned to them (their lane).
  const SEES_ALL: RoleKey[] = ['superAdmin', 'tenantAdmin'];
  const SEES: Record<string, (s: typeof started) => number[]> = {
    superAdmin: (s) => [s.editor, s.submitter, s.tenantAdmin, s.adminApproval],
    tenantAdmin: (s) => [s.editor, s.submitter, s.tenantAdmin, s.adminApproval],
    // Started by the editor; the editor is in no lane of these models.
    editor: (s) => [s.editor],
    // Started by the submitter, plus every Request instance (first task in the Submitters lane).
    submitter: (s) => [s.editor, s.submitter, s.tenantAdmin],
    viewer: () => [],
  };
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'submitter', 'viewer'] as RoleKey[]) {
    test(`RBAC-INST-LIST [${role(key).label}]: The instance list shows only the instances the role may see`, async ({ page }) => {
      await signInAs(page, role(key));
      const listed = await listedInstances(page);
      const ownOnly = !SEES_ALL.includes(key);
      // Rows the role neither started nor is assigned to (must be none for these roles).
      const foreign = ownOnly ? listed.rows.filter((r) => !r.started_by_me && !r.assigned_to_me).map((r) => r.id) : [];
      {
        const want = SEES[key](started).sort((a, b) => a - b);
        expect(listed.status, 'instance list through the API').toBe(200);
        expect.soft(listed.ids, "this file's instances listed").toEqual(want);
        expect.soft(foreign, 'listed instances neither started by nor assigned to this user').toEqual([]);

        // On screen: Process Instances searched for each model; a role with own instances only
        // sees "Started by me" or "Assigned to me" on every row.
        const byModel: Record<string, number[]> = {
          request: [started.editor, started.submitter, started.tenantAdmin],
          approval: [started.adminApproval],
        };
        for (const [modelKey, ids] of Object.entries(byModel)) {
          const name = flow.model(modelKey).name;
          await page.goto(`/process-instances?search=${encodeURIComponent(name)}`);
          await expect(page.getByRole('heading', { name: 'Process Instances', exact: true })).toBeVisible();
          const first = ids.find((id) => want.includes(id));
          if (first) await expect(instanceRow(page, name, first)).toBeVisible();
          else await expect(page.getByText(/no process instances|no results|no instances/i).first()).toBeVisible().catch(() => undefined);
          for (const id of ids) {
            const row = instanceRow(page, name, id);
            await expect.soft(row, `instance #${id} on screen`).toHaveCount(want.includes(id) ? 1 : 0);
            if (ownOnly && want.includes(id)) {
              await expect.soft(row, `instance #${id} shows Started by me / Assigned to me`).toContainText(/Started by me|Assigned to me/);
            }
          }
        }
      }
      logResult(`RBAC-INST-LIST [${role(key).label}]`, {
        scenario: `${role(key).label} lists instances (editor's #${started.editor}, submitter's #${started.submitter}, admin's #${started.tenantAdmin} = Submitters task; admin's approval #${started.adminApproval} = Approvers task)`,
        actions: ['GET the instance list', 'Check every row is started by or assigned to the user (own-instance roles)', 'Open Process Instances and search each model'],
        expected: `${SEES_ALL.includes(key) ? 'All instances' : 'Only instances started by or assigned to the user'}: ${SEES[key](started).map((i) => `#${i}`).join(', ') || 'none'} of this file`,
        actual: `API ${listed.status}: ${listed.ids.map((i) => `#${i}`).join(', ') || 'none'} of this file; ${listed.rows.length} rows in all${foreign.length ? `; not started/assigned: ${foreign.map((i) => `#${i}`).join(', ')}` : ''}`,
      });
    });
  }

  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const allowed = SEES_ALL.includes(key);
    test(`RBAC-INST-OPEN [${role(key).label}]: ${allowed ? 'Opens' : 'Cannot open'} an instance it neither started nor is assigned to`, async ({ page }) => {
      await signInAs(page, role(key));
      const id = started.adminApproval;
      const api = (await backendFetch(page, `/v1.0/m8flow/process-instances/${id}`)).status;
      await page.goto(`/process-instances/${id}`);
      const tabs = page.getByRole('tab', { name: 'Diagram', exact: true });
      if (allowed) {
        expect(api, `GET instance #${id}`).toBe(200);
        await expect(tabs).toBeVisible();
      } else {
        expect([403, 404], `GET instance #${id}`).toContain(api);
        await expect(page.getByText('Loading process instance…')).toHaveCount(0);
        await expect(page.getByText(/not found|failed to load|not authori[sz]ed|not available|forbidden/i).first(), 'a refusal message').toBeVisible();
        await expect(tabs).toHaveCount(0);
      }
      logResult(`RBAC-INST-OPEN [${role(key).label}]`, {
        scenario: `${role(key).label} opens the tenant admin's approval instance #${id} (Approvers task) by its address`,
        actions: ['Open /process-instances/<id>', 'GET the instance'],
        expected: allowed ? 'Instance page with its tabs; API 200' : 'Not found / not authorised, no data; API 403 or 404',
        actual: `API ${api}`,
      });
    });
  }

  for (const c of [
    { key: 'tenantAdmin' as RoleKey, instance: 'tenantAdmin' as const, manage: true },
    { key: 'editor' as RoleKey, instance: 'editor' as const, manage: true },
    // Super Admin with tenant m8flow selected manages the tenant's instances.
    { key: 'superAdmin' as RoleKey, instance: 'tenantAdmin' as const, manage: true },
    { key: 'submitter' as RoleKey, instance: 'submitter' as const, manage: false },
  ]) {
    test(`RBAC-INST-ACTIONS [${role(c.key).label}]: ${c.manage ? 'Suspend and Terminate are offered' : 'No Suspend or Terminate'}; the tabs are shown`, async ({ page }) => {
      await enter(page, c.key);
      const id = started[c.instance];
      await page.goto(`/process-instances/${id}`);
      for (const tab of ['Diagram', 'Milestones', 'Events', 'Messages', 'Tasks']) {
        await expect.soft(page.getByRole('tab', { name: tab, exact: true }), `${tab} tab`).toBeVisible();
      }
      await page.getByRole('tab', { name: 'Events', exact: true }).click();
      // Error messages only (an info notice such as "no tasks assigned to you" is fine).
      await expect.soft(page.locator('[role="alert"][data-tone="error"], p[role="alert"]'), 'no error on the Events tab').toHaveCount(0);
      for (const action of ['Suspend', 'Terminate']) {
        await expect.soft(page.getByRole('button', { name: action, exact: true }), `${action} button`).toHaveCount(c.manage ? 1 : 0);
      }
      let api = 'not tried (allowed role)';
      if (!c.manage) {
        const suspend = await backendFetch(page, `/v1.0/m8flow/process-instances/${id}/suspend`, { method: 'POST' });
        expect.soft(suspend.status, 'suspend through the API').toBe(403);
        api = `suspend ${suspend.status}`;
        if (suspend.status < 300) {
          await withPage(page.context().browser()!, tenantAdminCredentials(), (a) => backendFetch(a, `/v1.0/m8flow/process-instances/${id}/resume`, { method: 'POST' }));
        }
      }
      if (c.key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
      logResult(`RBAC-INST-ACTIONS [${role(c.key).label}]`, {
        scenario: `${role(c.key).label} on instance #${id}`,
        actions: ['Open the instance page', 'Check the tabs and open Events', 'Look for Suspend / Terminate', 'Try suspend through the API (denied roles)'],
        expected: `Diagram, Milestones, Events, Messages, Tasks tabs; Suspend / Terminate ${c.manage ? 'shown' : 'hidden, API 403'}`,
        actual: api,
      });
    });
  }

  test('RBAC-INST-349: The submitter still sees the instance after completing its task', async ({ browser }) => {
    const id = started.editor;
    await withPage(browser, submitterCredentials(), (s) => completeTaskInUi(s, id, { 'Request details': 'RBAC check' }, 'E2E Submit Request'));
    const after = await withPage(browser, submitterCredentials(), async (s) => ({
      listed: (await listedInstances(s)).ids.includes(id),
      open: (await backendFetch(s, `/v1.0/m8flow/process-instances/${id}`)).status,
    }));
    expect(after.listed, `instance #${id} is still listed for the submitter`).toBe(true);
    expect(after.open, `GET instance #${id}`).toBe(200);
    logResult('RBAC-INST-349', {
      scenario: "The submitter completes its task in the editor's instance",
      actions: ['Submitter submits E2E Submit Request', 'List and open the instance again'],
      expected: 'Still listed and opens',
      actual: `listed ${after.listed}; GET ${after.open}`,
    });
  });

  // =============================================================================================
  // The actions themselves (edit / delete / copy, modeler, tests, instance lifecycle)
  // =============================================================================================
  const MANAGERS: RoleKey[] = ['superAdmin', 'tenantAdmin', 'editor'];
  const encodeRoute = (route: string) => route.split(':').map(encodeURIComponent).join(':');

  // ---------------------------------------------------------------------------------------------
  // Edit / delete a process group (TC-041..044)
  // ---------------------------------------------------------------------------------------------
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const allowed = MANAGERS.includes(key);
    test(`RBAC-PRC-GROUP [${role(key).label}]: ${allowed ? 'Can' : 'Cannot'} edit and delete a process group`, async ({ page, browser }) => {
      const group = { id: `e2e-rbacg-${key.toLowerCase()}-${flow.stamp}`, name: `E2E RBAC Group ${key} ${flow.stamp}` };
      const renamed = `${group.name} renamed`;
      await withPage(browser, editorCredentials(), (e) => createMockGroup(e, { id: group.id, display_name: group.name }));
      const results: string[] = [];
      try {
        await enter(page, key);
        await page.goto('/processes');
        await page.getByRole('button', { name: 'All groups', exact: true }).click();
        const picker = page.getByRole('dialog', { name: 'Process groups' });
        await expect(picker).toBeVisible();
        const edit = picker.getByRole('button', { name: `Edit ${group.name}`, exact: true });
        const del = picker.getByRole('button', { name: `Delete ${group.name}`, exact: true });

        if (allowed) {
          await edit.click();
          const form = page.getByRole('dialog', { name: 'Edit process group' });
          await form.getByLabel('Process group display name').fill(renamed);
          await form.getByRole('button', { name: 'Save group' }).click();
          await expect(picker.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeVisible();
          results.push('renamed in the UI');

          await picker.getByRole('button', { name: `Delete ${renamed}`, exact: true }).click();
          const confirm = page.getByRole('dialog', { name: 'Delete process group' });
          await confirm.getByRole('button', { name: 'Delete group' }).click();
          await expect(picker.getByRole('button', { name: `Delete ${renamed}`, exact: true })).toHaveCount(0);
          // The row leaves the list before the server has finished deleting: wait for the server.
          await expect
            .poll(async () => {
              const groups = await withPage(browser, tenantAdminCredentials(), (a) => backendFetch(a, '/v1.0/m8flow/process-groups?per_page=500'));
              const body = groups.body as { results?: { id: string }[] } | { id: string }[] | null;
              return (Array.isArray(body) ? body : body?.results ?? []).map((g) => g.id).includes(group.id);
            }, { message: 'the deleted group is no longer listed (tenant admin)', timeout: 15_000 })
            .toBe(false);
          results.push('deleted in the UI (no longer listed)');
        } else {
          await expect.soft(edit, 'Edit group button').toHaveCount(0);
          await expect.soft(del, 'Delete group button').toHaveCount(0);
          const put = await backendFetch(page, `/v1.0/m8flow/process-groups/${encodeURIComponent(group.id)}`, {
            method: 'PUT',
            data: { display_name: renamed, description: '' },
          });
          const remove = await backendFetch(page, `/v1.0/m8flow/process-groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
          expect.soft(put.status, 'edit the group through the API').toBe(403);
          expect.soft(remove.status, 'delete the group through the API').toBe(403);
          results.push(`buttons hidden; PUT ${put.status}, DELETE ${remove.status}`);
        }
      } finally {
        if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants').catch(() => undefined);
        await withPage(browser, tenantAdminCredentials(), (a) => deleteMockGroup(a, group.id));
      }
      logResult(`RBAC-PRC-GROUP [${role(key).label}]`, {
        scenario: `${role(key).label} edits and deletes a process group made by the editor${key === 'superAdmin' ? ' (m8flow selected)' : ''}`,
        actions: allowed
          ? ['Processes -> All groups', 'Edit -> new name -> Save group', 'Delete -> Delete group']
          : ['Processes -> All groups', 'Look for Edit / Delete', 'PUT and DELETE the group through the API'],
        expected: allowed ? 'Renamed and deleted' : 'Edit / Delete hidden; API 403 for both, group unchanged',
        actual: results.join('; '),
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Copy / delete a process model (TC-049..052)
  // ---------------------------------------------------------------------------------------------
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const allowed = MANAGERS.includes(key);
    test(`RBAC-PRC-COPYDEL [${role(key).label}]: ${allowed ? 'Can' : 'Cannot'} copy and delete a process model`, async ({ page, browser }) => {
      // A model of its own (the editor creates it), so a wrong delete cannot break other tests.
      const m = await flow.fresh(browser, 'approval');
      const copy = { id: `${m.id}-copy`, name: `${m.name} (copy)` };
      const copyRoute = `${flow.groupId}:${copy.id}`;
      flow.track.models.push(copyRoute);
      const results: string[] = [];
      await enter(page, key);

      if (allowed) {
        // Copy from the model page.
        await page.goto(`/processes/${m.route}`);
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Copy process model' });
        await expect(dialog.getByLabel('Process model ID')).toHaveValue(copy.id);
        await dialog.getByRole('button', { name: 'Copy process model' }).click();
        await expect(dialog).toHaveCount(0);
        const copied = await withPage(browser, tenantAdminCredentials(), (a) => backendFetch(a, `/v1.0/m8flow/process-models/${encodeRoute(copyRoute)}`));
        expect(copied.status, 'the copy exists (GET as tenant admin)').toBe(200);
        results.push(`copied (status ${(copied.body as { status?: string } | null)?.status ?? '?'})`);

        // Delete the copy from the group's model list.
        await page.goto(`/processes?group=${encodeURIComponent(flow.groupId)}`);
        await modelRow(page, copy.name).getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menu').getByRole('menuitem', { name: 'Delete', exact: true }).click();
        await page.getByRole('alertdialog', { name: 'Delete process model?' }).getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(modelRow(page, copy.name)).toHaveCount(0);
        // The server may take a moment; a copy still served after 15 s was not deleted.
        let gone = 0;
        await expect
          .poll(async () => (gone = (await withPage(browser, tenantAdminCredentials(), (a) => backendFetch(a, `/v1.0/m8flow/process-models/${encodeRoute(copyRoute)}`))).status), {
            message: 'the deleted copy is gone (GET as tenant admin)',
            timeout: 15_000,
          })
          .toBe(404);
        results.push(`deleted the copy (GET ${gone})`);
      } else {
        await page.goto(`/processes?group=${encodeURIComponent(flow.groupId)}`);
        await expect(modelRow(page, m.name)).toBeVisible();
        const more = modelRow(page, m.name).getByRole('button', { name: 'More actions', exact: true });
        let items: string[] = [];
        if (await more.count()) {
          await more.click();
          items = await menuItemLabels(page.getByRole('menu'));
          await closeMenu(page);
        }
        expect.soft(items.filter((i) => i === 'Delete' || i === 'Copy'), 'Copy / Delete in the row menu').toEqual([]);
        const copied = await backendFetch(page, `/v1.0/m8flow/process-models/${encodeRoute(m.route)}/copy`, {
          method: 'POST',
          data: { id: copy.id, display_name: copy.name },
        });
        const removed = await backendFetch(page, `/v1.0/m8flow/process-models/${encodeRoute(m.route)}`, { method: 'DELETE' });
        expect.soft(copied.status, 'copy the model through the API').toBe(403);
        expect.soft(removed.status, 'delete the model through the API').toBe(403);
        results.push(`row menu: ${items.join(', ') || 'none'}; POST copy ${copied.status}, DELETE ${removed.status}`);
      }
      if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
      logResult(`RBAC-PRC-COPYDEL [${role(key).label}]`, {
        scenario: `${role(key).label} copies and deletes a process model${key === 'superAdmin' ? ' (m8flow selected)' : ''}`,
        actions: allowed
          ? ['Model page -> More actions -> Copy', 'Group list -> row menu -> Delete the copy']
          : ['Group list -> row menu', 'Copy and delete through the API'],
        expected: allowed ? 'Copy created, then deleted' : 'No Copy / Delete; API 403 for both, nothing changes',
        actual: results.join('; '),
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Open the diagram in the modeler: editable or read-only (TC-047, 048, 056, 057)
  // ---------------------------------------------------------------------------------------------
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const edit = MANAGERS.includes(key);
    const view = key !== 'submitter';
    test(`RBAC-PRC-MODELER [${role(key).label}]: ${edit ? 'Opens the diagram to edit' : view ? 'Opens the diagram read-only' : 'Cannot open the diagram'}`, async ({ page }) => {
      const m = flow.model('request');
      await enter(page, key);
      await page.goto(`/processes/${m.route}/modeler/${encodeURIComponent(m.bpmnFile)}`);
      const canvas = page.locator('.djs-container');
      const palette = page.locator('.djs-palette');
      // The primary file cannot be deleted, so "New file" shows the editing toolbar.
      const newFile = page.getByRole('button', { name: 'New file', exact: true });
      if (view) {
        await expect(canvas).toBeVisible();
        await expect(page.locator(`[data-element-id="Activity_submit_request"]`)).toBeVisible();
        await expect.soft(palette, 'drawing palette').toBeVisible({ visible: edit });
        await expect.soft(newFile, 'New file button').toHaveCount(edit ? 1 : 0);
      } else {
        await expect(page.getByText(/not found|failed|not authori[sz]ed|not available|forbidden|permission/i).first(), 'a refusal message').toBeVisible();
        await expect(canvas).toHaveCount(0);
      }
      if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
      logResult(`RBAC-PRC-MODELER [${role(key).label}]`, {
        scenario: `${role(key).label} opens the model's BPMN file in the modeler`,
        actions: ['Open /processes/<model>/modeler/<file>'],
        expected: edit ? 'Diagram with palette and New file (editable)' : view ? 'Diagram without palette or New file (read-only)' : 'Refused, no diagram',
        actual: view ? 'Diagram shown' : 'Refused',
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Model tests (TC-062, 063)
  // ---------------------------------------------------------------------------------------------
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'submitter'] as RoleKey[]) {
    const allowed = MANAGERS.includes(key);
    test(`RBAC-PRC-TESTS [${role(key).label}]: ${allowed ? 'Can' : 'Cannot'} run the model's tests`, async ({ page }) => {
      const m = flow.model('request');
      await enter(page, key);
      await page.goto(`/processes/${m.route}`);
      await expect(page.getByRole('heading', { name: m.name, exact: true })).toBeVisible();
      const link = page.getByRole('link', { name: 'Tests', exact: true });
      let api = 'not tried';
      if (allowed) {
        await link.click();
        const card = page.locator('#tests');
        await expect(card.getByRole('button', { name: 'Run BPMN tests' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Create script unit test' })).toBeVisible();
      } else {
        await expect.soft(link, 'Tests section link').toHaveCount(0);
        await expect.soft(page.locator('#tests'), 'Tests section').toHaveCount(0);
        const run = await backendFetch(page, `/v1.0/m8flow/process-models/${encodeRoute(m.route)}/tests/run`, { method: 'POST', data: {} });
        expect.soft(run.status, 'run the tests through the API').toBe(403);
        api = `POST tests/run ${run.status}`;
      }
      if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
      logResult(`RBAC-PRC-TESTS [${role(key).label}]`, {
        scenario: `${role(key).label} on the model's Tests section`,
        actions: ['Open the model page', 'Open Tests', 'Run the tests through the API (denied roles)'],
        expected: allowed ? 'Tests section with Run BPMN tests and Create script unit test' : 'No Tests section; API 403',
        actual: allowed ? 'Tests section shown' : api,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Instance lifecycle: suspend, resume, terminate, delete (TC-072, 078, 081; Super Admin with a
  // tenant selected acts like the Tenant Admin -- decision 17 Nov, replaces TC-074/080/083/302)
  // ---------------------------------------------------------------------------------------------
  for (const c of [
    { key: 'tenantAdmin' as RoleKey, starter: tenantAdminCredentials },
    { key: 'editor' as RoleKey, starter: editorCredentials },
    { key: 'superAdmin' as RoleKey, starter: tenantAdminCredentials },
  ]) {
    test(`RBAC-INST-LIFECYCLE [${role(c.key).label}]: Suspends, resumes, terminates and deletes an instance`, async ({ page, browser }) => {
      const id = await withPage(browser, c.starter(), (p) => startInstance(p, flow, flow.model('approval').route));
      const statusOf = (s: string | string[]) => withPage(browser, tenantAdminCredentials(), (a) => waitForStatus(a, id, s));
      await enter(page, c.key);
      await page.goto(`/process-instances/${id}`);
      await expect(page.getByRole('tab', { name: 'Diagram', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Suspend', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
      await statusOf('suspended');

      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible();
      await statusOf(['user_input_required', 'waiting', 'running']);

      await page.getByRole('button', { name: 'Terminate', exact: true }).click();
      const terminate = page.getByRole('alertdialog', { name: 'Terminate process instance?' }).or(page.getByRole('dialog', { name: 'Terminate process instance?' }));
      await terminate.getByRole('button', { name: 'Terminate', exact: true }).click();
      await expect(page.getByText('Terminated', { exact: true }).first()).toBeVisible();
      await statusOf('terminated');

      await page.getByRole('button', { name: 'Delete process instance', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Delete process instance?' }).or(page.getByRole('dialog', { name: 'Delete process instance?' }));
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page).toHaveURL(/\/process-instances\/?(\?.*)?$/);
      const gone = await withPage(browser, tenantAdminCredentials(), (a) => backendFetch(a, `/v1.0/m8flow/process-instances/${id}`));
      expect(gone.status, 'the deleted instance is gone (GET as tenant admin)').toBe(404);
      if (c.key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');

      logResult(`RBAC-INST-LIFECYCLE [${role(c.key).label}]`, {
        scenario: `${role(c.key).label} on instance #${id}${c.key === 'superAdmin' ? ' (m8flow selected; started by the tenant admin)' : ''}`,
        actions: ['Suspend', 'Resume', 'Terminate and confirm', 'Delete and confirm'],
        expected: 'Status Suspended, then running again, then Terminated; deleted (GET 404)',
        actual: `Done; GET after delete ${gone.status}`,
      });
    });
  }

  test('RBAC-INST-SA-ALL: Super Admin with All tenants has no instance actions', async ({ page, browser }) => {
    const id = await withPage(browser, tenantAdminCredentials(), (p) => startInstance(p, flow, flow.model('approval').route));
    await signInAs(page, role('superAdmin'));
    await selectTenantAsSuperAdmin(page, 'All tenants');
    await page.goto(`/process-instances/${id}`);
    await expect(page.getByRole('tab', { name: 'Diagram', exact: true })).toBeVisible();
    for (const action of ['Suspend', 'Terminate', 'Resume']) {
      await expect.soft(page.getByRole('button', { name: action, exact: true }), `${action} (running)`).toHaveCount(0);
    }
    expect(await withPage(browser, tenantAdminCredentials(), (a) => instanceAction(a, id, 'terminate'))).toBeLessThan(300);
    await page.reload();
    await expect(page.getByText('Terminated', { exact: true }).first()).toBeVisible();
    await expect.soft(page.getByRole('button', { name: 'Delete process instance', exact: true }), 'Delete (terminated)').toHaveCount(0);
    logResult('RBAC-INST-SA-ALL', {
      scenario: `Super Admin with All tenants on the tenant admin's instance #${id}`,
      actions: ['Open the running instance', 'Tenant admin terminates it', 'Open it again'],
      expected: 'No Suspend / Resume / Terminate while running; no Delete once terminated',
      actual: 'Checked',
    });
  });

  test('RBAC-INST-LIFECYCLE-DENIED: Viewer and Submitter cannot suspend, terminate or delete', async ({ page, browser }) => {
    // Submitter: its own instance (Approvers task, so not assigned to it).
    const own = await withPage(browser, submitterCredentials(), (p) => startInstance(p, flow, flow.model('approval').route));
    const results: string[] = [];
    await signInAs(page, role('submitter'));
    await page.goto(`/process-instances/${own}`);
    await expect(page.getByRole('tab', { name: 'Diagram', exact: true })).toBeVisible();
    for (const action of ['Suspend', 'Terminate']) {
      await expect.soft(page.getByRole('button', { name: action, exact: true }), `Submitter: ${action}`).toHaveCount(0);
    }
    const subSuspend = await instanceAction(page, own, 'suspend');
    const subTerminate = await instanceAction(page, own, 'terminate');
    expect.soft(subSuspend, 'Submitter: suspend through the API').toBe(403);
    expect.soft(subTerminate, 'Submitter: terminate through the API').toBe(403);
    // Once the tenant admin terminated it, the submitter still cannot delete it.
    await withPage(browser, tenantAdminCredentials(), async (a) => {
      await instanceAction(a, own, 'terminate');
      await waitForStatus(a, own, 'terminated');
    });
    await page.reload();
    await expect(page.getByText('Terminated', { exact: true }).first()).toBeVisible();
    await expect.soft(page.getByRole('button', { name: 'Delete process instance', exact: true }), 'Submitter: Delete').toHaveCount(0);
    const subDelete = (await backendFetch(page, `/v1.0/m8flow/process-instances/${own}`, { method: 'DELETE' })).status;
    expect.soft([403, 404], 'Submitter: delete through the API').toContain(subDelete);
    results.push(`Submitter on own #${own}: suspend ${subSuspend}, terminate ${subTerminate}, delete ${subDelete}`);

    // Viewer: the tenant admin's running instance.
    const other = await withPage(browser, tenantAdminCredentials(), (p) => startInstance(p, flow, flow.model('approval').route));
    const v = await withPage(browser, viewerCredentials(), async (vp) => ({
      suspend: await instanceAction(vp, other, 'suspend'),
      terminate: await instanceAction(vp, other, 'terminate'),
      remove: (await backendFetch(vp, `/v1.0/m8flow/process-instances/${other}`, { method: 'DELETE' })).status,
    }));
    expect.soft([403, 404], 'Viewer: suspend through the API').toContain(v.suspend);
    expect.soft([403, 404], 'Viewer: terminate through the API').toContain(v.terminate);
    expect.soft([403, 404], 'Viewer: delete through the API').toContain(v.remove);
    const after = await withPage(browser, tenantAdminCredentials(), (a) => backendFetch(a, `/v1.0/m8flow/process-instances/${other}`));
    expect.soft(after.status, "the tenant admin's instance is still there").toBe(200);
    results.push(`Viewer on #${other}: suspend ${v.suspend}, terminate ${v.terminate}, delete ${v.remove}`);

    logResult('RBAC-INST-LIFECYCLE-DENIED', {
      scenario: 'Submitter on its own instance; Viewer on the tenant admin instance',
      actions: ['Look for Suspend / Terminate / Delete', 'Try suspend, terminate and delete through the API'],
      expected: 'No buttons; API refused (403, or 404 where the role cannot see the instance); nothing changes',
      actual: results.join('; '),
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task data on the instance page (TC-084)
  // ---------------------------------------------------------------------------------------------
  let dataInstance = 0;
  const dataNote = `RBAC task data ${flow.stamp}`;
  for (const key of ['superAdmin', 'tenantAdmin', 'editor', 'submitter'] as RoleKey[]) {
    test(`RBAC-INST-DATA [${role(key).label}]: Sees the task data on the instance page`, async ({ page, browser }) => {
      if (!dataInstance) {
        // Started by the editor; the submitter fills the first task.
        dataInstance = await withPage(browser, editorCredentials(), (p) => startInstance(p, flow, flow.model('request').route));
        await withPage(browser, submitterCredentials(), (s) =>
          completeTask(s, dataInstance, { request_details: dataNote }, 'E2E Submit Request'));
      }
      await enter(page, key);
      await page.goto(`/process-instances/${dataInstance}`);
      await page.locator('[data-element-id="Activity_submit_request"]').click();
      const dialog = page.getByRole('dialog', { name: /E2E Submit Request/ });
      await expect(dialog.getByText('Task data', { exact: true })).toBeVisible();
      await expect(dialog).toContainText(dataNote);
      if (key === 'superAdmin') await selectTenantAsSuperAdmin(page, 'All tenants');
      logResult(`RBAC-INST-DATA [${role(key).label}]`, {
        scenario: `${role(key).label} opens the completed task of instance #${dataInstance}`,
        actions: ['Open the instance', 'Click E2E Submit Request on the diagram'],
        expected: `Task data shows "${dataNote}"`,
        actual: 'Shown',
      });
    });
  }
});
