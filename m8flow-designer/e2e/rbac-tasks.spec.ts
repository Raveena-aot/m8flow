import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  reviewerCredentials,
  submitterCredentials,
  superAdminCredentials,
  tenantAdminCredentials,
} from './helpers/auth';
import { backendFetch } from './helpers/backendApi';
import {
  completeTask,
  hasTaskFor,
  myTasks,
  instanceDetail,
  startInstance,
  submitTask,
  tableRows,
  taskTitle,
  useFlowCatalog,
  waitForTask,
  withPage,
  type TaskItem,
} from './helpers/processFlow';
import { logResult } from './helpers/processesPage';
import { ROLES, role, signInAs, type RoleKey } from './helpers/rbac';

/**
 * RBAC: Task Review per role.
 *
 * RBAC-TASK-INBOX  who has Task Review: menu, page and API (TC-089, 090)
 * RBAC-TASK-OWN    each role opens and submits a task of its own lane (TC-091, 093)
 * RBAC-TASK-SA     Super Admin opens anyone's task but cannot submit it (TC-095, 096)
 * RBAC-TASK-OTHER  a task assigned to someone else cannot be opened or submitted (TC-092, 094, 097)
 * RBAC-TASK-LANE   a lane task goes to the lane's group only; a task role does not override the
 *                  lane (TC-275, 277, 278)
 * RBAC-TASK-HANDOFF after the Submitters task, the next task goes to the Approvers lane only; the
 *                  submitter cannot open it, nor submit its own completed task again
 * RBAC-TASK-LANES  three lanes at once: each task reaches its own lane's role only, and the task
 *                  of a lane with no members reaches nobody
 * RBAC-TASK-IDOR   guessing task ids gives 404 (TC-288)
 *
 * Seeded templates: flow-single-approval (one task in the Approvers lane: reviewer),
 * flow-submit-then-approve (first task in the Submitters lane: submitter), flow-lanes (three
 * tasks at once: Administrators = tenant admin, Designers = editor, and a lane nobody is in).
 * Instances are started by the submitter. Everything is deleted afterwards.
 */

const flow = useFlowCatalog(test, 'rbact', {
  approval: { name: 'RBAC Task Approval', template: 'flow-single-approval' },
  submit: { name: 'RBAC Task Submit', template: 'flow-submit-then-approve' },
  lanes: { name: 'RBAC Task Lanes', template: 'flow-lanes' },
});

const TASK = {
  approval: { name: 'E2E Approve Request', bpmnId: 'Activity_approve_request', field: 'Approval note' },
  submit: { name: 'E2E Submit Request', bpmnId: 'Activity_submit_request', field: 'Request details' },
  admin: { name: 'E2E Admin Approval', bpmnId: 'Activity_admin_approval', field: 'Approval note' },
  designers: { name: 'E2E Design Sign-off', bpmnId: 'Activity_designers_signoff', field: 'Approval note' },
};

const INBOX_ROLES: RoleKey[] = ['superAdmin', 'tenantAdmin', 'submitter', 'reviewer'];

/** Starts an instance of the model as the submitter. */
function start(browser: Browser, key: string): Promise<number> {
  return withPage(browser, submitterCredentials(), (p) => startInstance(p, flow, flow.model(key).route));
}

/**
 * A task of the instance by its name, read from the Super Admin's Task Review list (it sees every
 * pending task). Used for the editor, whose role has no Task Review list of its own.
 */
async function taskFromSuperAdmin(browser: Browser, instanceId: number, name: string): Promise<TaskItem> {
  return withPage(
    browser,
    superAdminCredentials(),
    async (sa) => {
      let found: TaskItem | undefined;
      await expect
        .poll(
          async () => {
            const list = await backendFetch(sa, '/v1.0/m8flow/task-review?per_page=100');
            const rows = ((list.body as { results?: TaskItem[] } | null)?.results ?? []) as TaskItem[];
            found = rows.find((t) => t.process_instance_id === instanceId && (taskTitle(t) === name || t.task_name === name));
            return Boolean(found);
          },
          { message: `task "${name}" of instance #${instanceId} is pending`, timeout: 30_000 },
        )
        .toBe(true);
      return found!;
    },
    'platformAdmin',
  );
}

/** State of a task of the instance (by BPMN id), read as the tenant admin. */
async function taskState(browser: Browser, instanceId: number, bpmnId: string): Promise<string> {
  return withPage(browser, tenantAdminCredentials(), async (a) => {
    const detail = await instanceDetail(a, instanceId);
    const tasks = detail.tasks.filter((t) => t.bpmn_identifier === bpmnId);
    return tasks.some((t) => /^completed$/i.test(t.state)) ? 'COMPLETED' : tasks.at(-1)?.state ?? 'none';
  });
}

/** True when the task page is not shown: sent back to Home, or "Task not found.". */
async function taskPageRefused(page: Page, taskId: number): Promise<string> {
  await page.goto(`/task-review/${taskId}`);
  let how = '';
  await expect
    .poll(
      async () => {
        if (new URL(page.url()).pathname === '/') how = 'sent to Home';
        else if (await page.getByText('Task not found.', { exact: true }).isVisible()) how = '"Task not found."';
        return how;
      },
      { message: 'the task page is refused', timeout: 20_000 },
    )
    .not.toBe('');
  return how;
}

test.describe('RBAC: Task Review per role', { tag: ['@rbac', '@permissions'] }, () => {
  // ---------------------------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------------------------
  for (const r of ROLES) {
    const allowed = INBOX_ROLES.includes(r.key);
    test(`RBAC-TASK-INBOX [${r.label}]: ${allowed ? 'Has' : 'Has no'} Task Review`, async ({ page }) => {
      await signInAs(page, r);
      await expect(page.locator('aside nav').getByRole('link', { name: 'Home', exact: true })).toBeVisible();
      await expect.soft(page.locator('aside nav').getByRole('link', { name: 'Task Review', exact: true }), 'Task Review menu').toHaveCount(allowed ? 1 : 0);
      const api = (await backendFetch(page, '/v1.0/m8flow/task-review?per_page=1')).status;
      await page.goto('/task-review');
      if (allowed) {
        await expect(page.getByRole('heading', { level: 1, name: 'Task Review', exact: true })).toBeVisible();
        expect(api, 'GET /task-review').toBe(200);
      } else {
        await expect(page).toHaveURL((url) => url.pathname === '/');
        expect(api, 'GET /task-review').toBe(403);
      }
      logResult(`RBAC-TASK-INBOX [${r.label}]`, {
        scenario: `${r.label} and Task Review`,
        actions: ['Look for the Task Review menu', 'Open /task-review', 'GET /task-review'],
        expected: allowed ? 'Menu shown; inbox opens; API 200' : 'No menu; /task-review goes back to Home; API 403',
        actual: `API ${api}; page ${allowed ? 'opened' : 'sent to Home'}`,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // A task of my own lane: open and submit it
  // ---------------------------------------------------------------------------------------------
  for (const c of [
    { key: 'tenantAdmin' as RoleKey, model: 'lanes', task: TASK.admin, lane: 'Administrators' },
    { key: 'submitter' as RoleKey, model: 'submit', task: TASK.submit, lane: 'Submitters' },
    { key: 'reviewer' as RoleKey, model: 'approval', task: TASK.approval, lane: 'Approvers' },
    { key: 'editor' as RoleKey, model: 'lanes', task: TASK.designers, lane: 'Designers' },
  ]) {
    test(`RBAC-TASK-OWN [${role(c.key).label}]: Opens and submits a task of its own lane (${c.lane})`, async ({ page, browser }) => {
      const id = await start(browser, c.model);
      const r = role(c.key);
      const inbox = INBOX_ROLES.includes(c.key);
      const task = inbox
        ? await withPage(browser, r.persona(), (p) => waitForTask(p, id, c.task.name))
        : await taskFromSuperAdmin(browser, id, c.task.name);
      await signInAs(page, r);
      if (inbox) {
        await page.goto('/task-review');
        await expect(tableRows(page, flow.model(c.model).name).filter({ hasText: c.task.name }).first(), 'the task is in my inbox').toBeVisible();
      }
      const detail = (await backendFetch(page, `/v1.0/m8flow/task-review/${task.id}`)).status;
      expect.soft(detail, 'GET the task').toBe(200);
      await page.goto(`/task-review/${task.id}`);
      await expect(page.getByRole('heading', { level: 1, name: c.task.name, exact: true })).toBeVisible();
      await page.getByLabel(c.task.field).fill(`RBAC ${c.key}`);
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(page).not.toHaveURL(new RegExp(`/task-review/${task.id}$`));
      await expect.poll(() => taskState(browser, id, c.task.bpmnId), { message: 'the task is completed', timeout: 30_000 }).toBe('COMPLETED');
      logResult(`RBAC-TASK-OWN [${r.label}]`, {
        scenario: `${r.label} works the ${c.lane} task "${c.task.name}" of instance #${id}`,
        actions: [...(inbox ? ['Find it in Task Review'] : []), 'Open /task-review/<id>', `Fill ${c.task.field}`, 'Submit'],
        expected: `${inbox ? 'Listed in the inbox; ' : ''}opens; submitted; the task is completed`,
        actual: `GET ${detail}; completed`,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Super Admin: sees anyone's task, cannot submit
  // ---------------------------------------------------------------------------------------------
  test("RBAC-TASK-SA: Super Admin opens someone else's task but cannot submit it", async ({ page, browser }) => {
    const id = await start(browser, 'approval');
    const task = await withPage(browser, reviewerCredentials(), (p) => waitForTask(p, id));
    await signInAs(page, role('superAdmin'));
    const detail = (await backendFetch(page, `/v1.0/m8flow/task-review/${task.id}`)).status;
    expect.soft(detail, 'GET the task').toBe(200);
    await page.goto(`/task-review/${task.id}`);
    await expect(page.getByRole('heading', { level: 1, name: TASK.approval.name, exact: true })).toBeVisible();
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    const note = page.getByLabel(TASK.approval.field);
    if (await note.isEditable().catch(() => false)) await note.fill('super admin');
    if (await submit.count()) await expect.soft(submit, 'Submit is not usable').toBeDisabled();
    const api = (await submitTask(page, task.id, { approval_note: 'super admin' })).status;
    expect.soft(api, 'submit through the API').toBe(403);
    expect(await withPage(browser, reviewerCredentials(), (p) => hasTaskFor(p, id)), 'still pending for the reviewer').toBe(true);
    logResult('RBAC-TASK-SA', {
      scenario: `Super Admin and the reviewer's task of instance #${id}`,
      actions: ['GET the task', 'Open /task-review/<id>', 'Try Submit', 'Submit through the API'],
      expected: 'Opens; no usable Submit; API submit 403; the task stays with the reviewer',
      actual: `GET ${detail}; submit API ${api}; still pending`,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // A task assigned to someone else
  // ---------------------------------------------------------------------------------------------
  for (const key of ['tenantAdmin', 'editor', 'viewer', 'integrator', 'submitter', 'reviewer'] as RoleKey[]) {
    // The reviewer is tried on the tenant admin's task; everyone else on the reviewer's task.
    const ownerIsAdmin = key === 'reviewer';
    test(`RBAC-TASK-OTHER [${role(key).label}]: Cannot open or submit a task assigned to someone else`, async ({ page, browser }) => {
      const id = await start(browser, ownerIsAdmin ? 'lanes' : 'approval');
      const owner = ownerIsAdmin ? tenantAdminCredentials : reviewerCredentials;
      const t = ownerIsAdmin ? TASK.admin : TASK.approval;
      const task = await withPage(browser, owner(), (p) => waitForTask(p, id, t.name));
      await signInAs(page, role(key));
      const how = await taskPageRefused(page, task.id);
      await expect.soft(page.getByRole('button', { name: 'Submit', exact: true }), 'Submit button').toHaveCount(0);
      const detail = (await backendFetch(page, `/v1.0/m8flow/task-review/${task.id}`)).status;
      const submit = (await submitTask(page, task.id, { approval_note: 'not mine' })).status;
      expect.soft([403, 404], 'GET the task').toContain(detail);
      expect.soft([403, 404], 'submit the task').toContain(submit);
      expect(await withPage(browser, owner(), (p) => hasTaskFor(p, id)), 'still pending for its owner').toBe(true);
      logResult(`RBAC-TASK-OTHER [${role(key).label}]`, {
        scenario: `${role(key).label} and the ${ownerIsAdmin ? "tenant admin's" : "reviewer's"} task of instance #${id}`,
        actions: ['Open /task-review/<id>', 'GET the task', 'Submit through the API'],
        expected: 'Not shown (Home or "Task not found."); no Submit; API 403 or 404; the task stays with its owner',
        actual: `Page ${how}; GET ${detail}; submit ${submit}; still pending`,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Lanes
  // ---------------------------------------------------------------------------------------------
  test('RBAC-TASK-LANE: An Approvers lane task goes to the Approvers group only', async ({ browser }) => {
    const id = await start(browser, 'approval');
    await withPage(browser, reviewerCredentials(), (p) => waitForTask(p, id));
    const has: Record<string, boolean> = {};
    for (const r of ROLES) {
      if (r.key === 'superAdmin') continue; // sees every pending task (monitoring, RBAC-TASK-SA)
      has[r.key] = await withPage(browser, r.persona(), (p) => hasTaskFor(p, id));
    }
    const holders = Object.entries(has).filter(([, v]) => v).map(([k]) => k);
    expect(holders, 'roles that get the task').toEqual(['reviewer']);

    const waiting = await withPage(browser, tenantAdminCredentials(), async (a) => {
      await a.goto(`/process-instances/${id}`);
      const cell = a.getByText('Group: Approvers', { exact: true });
      await expect.soft(cell, 'Waiting for: Group: Approvers').toBeVisible();
      return (await cell.count()) > 0;
    });
    logResult('RBAC-TASK-LANE', {
      scenario: `Instance #${id}: one task in the Approvers lane`,
      actions: ["Check each role's Task Review list", 'Open the instance as tenant admin'],
      expected: 'Only the reviewer gets the task (editor, submitter, tenant admin do not, whatever their role allows); the instance shows "Group: Approvers"',
      actual: `Task held by: ${holders.join(', ') || 'nobody'}; "Group: Approvers" ${waiting ? 'shown' : 'not shown'}`,
    });
  });

  test('RBAC-TASK-HANDOFF: After the submitter, the next task goes to the Approvers lane only', async ({ page, browser }) => {
    const id = await start(browser, 'submit');
    const first = await withPage(browser, submitterCredentials(), (p) =>
      completeTask(p, id, { request_details: 'RBAC handoff' }, TASK.submit.name));
    const second = await withPage(browser, reviewerCredentials(), (p) => waitForTask(p, id, TASK.approval.name));

    // Nobody else gets the approval task.
    const others: Record<string, boolean> = {};
    for (const key of ['tenantAdmin', 'submitter', 'editor', 'viewer', 'integrator'] as RoleKey[]) {
      others[key] = await withPage(browser, role(key).persona(), (p) => hasTaskFor(p, id));
    }
    expect(Object.entries(others).filter(([, v]) => v).map(([k]) => k), 'other roles holding a task of the instance').toEqual([]);

    // The submitter cannot open the approval task, nor submit its own completed task again.
    await signInAs(page, role('submitter'));
    const how = await taskPageRefused(page, second.id);
    const approvalGet = (await backendFetch(page, `/v1.0/m8flow/task-review/${second.id}`)).status;
    const approvalSubmit = (await submitTask(page, second.id, { approval_note: 'not mine' })).status;
    expect.soft([403, 404], 'GET the approval task').toContain(approvalGet);
    expect.soft([403, 404], 'submit the approval task').toContain(approvalSubmit);
    const again = (await submitTask(page, first.id, { request_details: 'again' })).status;
    expect.soft(again, 'submit the completed Submitters task again').toBeGreaterThanOrEqual(400);
    await page.goto('/task-review');
    await expect(page.getByRole('heading', { level: 1, name: 'Task Review', exact: true })).toBeVisible();
    await expect.soft(tableRows(page, flow.model('submit').name), "the instance's tasks in the submitter's inbox").toHaveCount(0);
    expect(await withPage(browser, reviewerCredentials(), (p) => hasTaskFor(p, id)), 'still pending for the reviewer').toBe(true);

    logResult('RBAC-TASK-HANDOFF', {
      scenario: `Instance #${id}: Submitters task, then Approvers task`,
      actions: ['Submitter submits E2E Submit Request', "Check every role's Task Review", 'Submitter opens and submits the approval task', 'Submitter submits its completed task again'],
      expected: 'Only the reviewer gets E2E Approve Request; the submitter cannot open or submit it, and its own task cannot be submitted twice',
      actual: `Approval task #${second.id}: page ${how}, GET ${approvalGet}, submit ${approvalSubmit}; resubmit of #${first.id}: ${again}`,
    });
  });

  test('RBAC-TASK-LANES: Three lanes at once, each task reaches its own lane only', async ({ browser }) => {
    const id = await start(browser, 'lanes');
    const tasks = {
      admin: await taskFromSuperAdmin(browser, id, TASK.admin.name),
      designers: await taskFromSuperAdmin(browser, id, TASK.designers.name),
      nobody: await taskFromSuperAdmin(browser, id, 'E2E Unassigned Approval'),
    };
    // Who may open each task (GET /task-review/<id>): the lane's role only, nobody for the empty lane.
    const owner: Record<keyof typeof tasks, RoleKey | null> = { admin: 'tenantAdmin', designers: 'editor', nobody: null };
    const rows: string[] = [];
    for (const key of ['tenantAdmin', 'editor', 'submitter', 'reviewer', 'viewer', 'integrator'] as RoleKey[]) {
      const result = await withPage(browser, role(key).persona(), async (p) => {
        const inbox = INBOX_ROLES.includes(key)
          ? (await myTasks(p)).filter((t) => t.process_instance_id === id).map((t) => taskTitle(t)).sort()
          : [];
        const get: Record<string, number> = {};
        for (const [name, t] of Object.entries(tasks)) get[name] = (await backendFetch(p, `/v1.0/m8flow/task-review/${t.id}`)).status;
        return { inbox, get };
      });
      const wantInbox = key === 'tenantAdmin' ? [TASK.admin.name] : [];
      expect.soft(result.inbox, `${role(key).label}: tasks of the instance in Task Review`).toEqual(wantInbox);
      for (const name of Object.keys(tasks) as (keyof typeof tasks)[]) {
        if (owner[name] === key) expect.soft(result.get[name], `${role(key).label}: GET the ${name} task`).toBe(200);
        else expect.soft([403, 404], `${role(key).label}: GET the ${name} task`).toContain(result.get[name]);
      }
      rows.push(`${role(key).label}: inbox [${result.inbox.join(', ') || 'none'}], GET admin ${result.get.admin} / designers ${result.get.designers} / nobody ${result.get.nobody}`);
    }
    logResult('RBAC-TASK-LANES', {
      scenario: `Instance #${id}: Administrators, Designers and an empty lane at the same time`,
      actions: ["Read each role's Task Review list", 'GET each of the three tasks as each role'],
      expected: 'Tenant admin: the Administrators task only; editor: opens the Designers task only (no inbox); the empty-lane task: nobody; other roles: none',
      actual: rows.join('; '),
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task id guessing
  // ---------------------------------------------------------------------------------------------
  test('RBAC-TASK-IDOR: Guessing task ids gives 404 for every task not assigned to the user', async ({ page, browser }) => {
    const approval = await start(browser, 'approval');
    const lanes = await start(browser, 'lanes');
    const reviewerTask = await withPage(browser, reviewerCredentials(), (p) => waitForTask(p, approval));
    const adminTask = await withPage(browser, tenantAdminCredentials(), (p) => waitForTask(p, lanes, TASK.admin.name));
    const designersTask = await taskFromSuperAdmin(browser, lanes, TASK.designers.name);
    const ids = [reviewerTask.id, adminTask.id, designersTask.id, Math.max(reviewerTask.id, adminTask.id, designersTask.id) + 1000];

    await signInAs(page, role('submitter'));
    const answers: string[] = [];
    for (const taskId of ids) {
      const get = (await backendFetch(page, `/v1.0/m8flow/task-review/${taskId}`)).status;
      const post = (await submitTask(page, taskId, { approval_note: 'guess' })).status;
      expect.soft(get, `GET task ${taskId}`).toBe(404);
      expect.soft(post, `submit task ${taskId}`).toBe(404);
      answers.push(`#${taskId}: GET ${get}, submit ${post}`);
    }
    expect(await withPage(browser, reviewerCredentials(), (p) => hasTaskFor(p, approval)), "the reviewer's task is still pending").toBe(true);
    logResult('RBAC-TASK-IDOR', {
      scenario: 'Submitter tries task ids that are not its own',
      actions: ["GET and submit the reviewer's, tenant admin's and editor's task ids, and an id that does not exist"],
      expected: '404 for every one; nothing changes',
      actual: answers.join('; '),
    });
  });
});
