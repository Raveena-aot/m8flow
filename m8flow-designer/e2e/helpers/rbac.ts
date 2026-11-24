import { expect, type Page } from '@playwright/test';

import {
  editorCredentials,
  integratorCredentials,
  reviewerCredentials,
  submitterCredentials,
  superAdminCredentials,
  tenantAdminCredentials,
  useSession,
  viewerCredentials,
  type DesignerPersona,
} from './auth';
import { backendFetch } from './backendApi';

/**
 * Role-based access (M8F-702): the seven roles, the menus and the expected access per role.
 *
 * Expected results come from M8Flow_RBAC_Test_Cases_v2 (Role-Permission Matrix) and the
 * product decisions of 16-17 Nov 2026. The Reviewer column is
 * not in the workbook: its expectations are marked provisional until confirmed.
 */

export type RoleKey = 'superAdmin' | 'tenantAdmin' | 'editor' | 'viewer' | 'integrator' | 'submitter' | 'reviewer';

export type Role = {
  key: RoleKey;
  label: string;
  persona: () => DesignerPersona;
  kind: 'shared' | 'platformAdmin';
};

export const ROLES: Role[] = [
  { key: 'superAdmin', label: 'Super Admin', persona: superAdminCredentials, kind: 'platformAdmin' },
  { key: 'tenantAdmin', label: 'Tenant Admin', persona: tenantAdminCredentials, kind: 'shared' },
  { key: 'editor', label: 'Editor', persona: editorCredentials, kind: 'shared' },
  { key: 'viewer', label: 'Viewer', persona: viewerCredentials, kind: 'shared' },
  { key: 'integrator', label: 'Integrator', persona: integratorCredentials, kind: 'shared' },
  { key: 'submitter', label: 'Submitter', persona: submitterCredentials, kind: 'shared' },
  { key: 'reviewer', label: 'Reviewer', persona: reviewerCredentials, kind: 'shared' },
];

export function role(key: RoleKey): Role {
  return ROLES.find((r) => r.key === key)!;
}

/** Signs the page in as the role (reusing its saved session) and opens Home. */
export async function signInAs(page: Page, r: Role): Promise<void> {
  await useSession(page, r.persona(), r.kind);
  if (r.kind === 'platformAdmin') await page.goto('/');
}

/** A sidebar menu: its label, the page it opens, and the permission the app checks to show it. */
export type Menu = {
  name: string;
  path: string;
  check: [uri: string, method: string];
  /** A real API call to ask instead of permissions-check, where the app decides by role, not by that check. */
  api?: string;
};

export const MENUS: Menu[] = [
  // The app shows Tenants to the super admin only (by role); the registry API itself is the server's answer.
  { name: 'Tenants', path: '/tenants', check: ['/m8flow/tenants', 'GET'], api: '/v1.0/m8flow/tenants' },
  { name: 'Tenant Management', path: '/tenant-management', check: ['/m8flow/tenant-management', 'GET'] },
  { name: 'Processes', path: '/processes', check: ['/process-models', 'GET'] },
  { name: 'Process Instances', path: '/process-instances', check: ['/process-instances/for-me', 'GET'] },
  { name: 'Task Review', path: '/task-review', check: ['/m8flow/task-review-access', 'GET'] },
  { name: 'Messages', path: '/messages', check: ['/messages', 'GET'] },
  { name: 'MCP Connection', path: '/mcp-connection', check: ['/m8flow/mcp-connection', 'GET'] },
  { name: 'MCP Tools', path: '/mcp-tools', check: ['/m8flow/mcp-tools', 'GET'] },
  // Configuration variables (named values) replaced the Secrets menu (main, Nov 2026). Secrets keep their page.
  { name: 'Configuration variables', path: '/configuration/named-values', check: ['/m8flow/named-values', 'GET'] },
  { name: 'Connectors', path: '/connectors', check: ['/m8flow/connectors-grouped', 'GET'] },
  { name: 'Templates', path: '/templates', check: ['/m8flow/templates', 'GET'] },
  { name: 'API Keys', path: '/api-keys', check: ['/m8flow/nats-tokens', 'GET'] },
  { name: 'Celery', path: '/system/celery', check: ['/m8flow/celery/overview', 'GET'] },
];

/**
 * Menus each role sees (Home is always shown). From the workbook's Navigation rows
 * (TC-M8F-RBAC-001..029). Messages (TC-013, decided 17 Nov 2026): Super Admin, Tenant Admin and
 * Editor only; not needed for Integrator, Submitter and Reviewer. Viewer is still under
 * discussion and kept as it is today (no Messages) until decided.
 * NATS is left out: it is conditional for the Tenant Admin (own tenant's events only).
 */
export const EXPECTED_MENUS: Record<RoleKey, string[]> = {
  superAdmin: ['Tenants', 'Processes', 'Process Instances', 'Task Review', 'Messages', 'MCP Connection', 'MCP Tools', 'Configuration variables', 'Connectors', 'Templates', 'API Keys', 'Celery'],
  tenantAdmin: ['Tenant Management', 'Processes', 'Process Instances', 'Task Review', 'Messages', 'MCP Connection', 'MCP Tools', 'Configuration variables', 'Connectors', 'Templates', 'API Keys'],
  editor: ['Processes', 'Process Instances', 'Messages', 'MCP Connection', 'Connectors', 'Templates'],
  viewer: ['Processes', 'Process Instances', 'Configuration variables', 'Connectors', 'Templates'],
  integrator: ['MCP Connection', 'Configuration variables', 'Connectors'],
  submitter: ['Processes', 'Process Instances', 'Task Review'],
  // Not in the workbook: Reviewer works the Approvers lane in Task Review.
  reviewer: ['Task Review'],
};

/**
 * Home cards and lists per role (TC-M8F-RBAC-030..034): who sees what on Home.
 * Super Admin has no "Tasks waiting on me" card or "My tasks" list (decided 17 Nov 2026,
 * unlike TC-031): it can view tasks but not work them.
 */
export const HOME_TASKS_ROLES: RoleKey[] = ['tenantAdmin', 'submitter', 'reviewer'];
export const HOME_TOTAL_TENANTS_ROLES: RoleKey[] = ['superAdmin'];

/** Sidebar groups per role: Setup holds Configuration variables/Connectors/Templates/API Keys; System holds Celery/NATS. */
export const SETUP_ROLES: RoleKey[] = ['superAdmin', 'tenantAdmin', 'editor', 'viewer', 'integrator'];
/** System: Super Admin only (Celery + NATS). The Tenant Admin lost NATS event history in M8F-700. */
export const SYSTEM_CHILDREN: Partial<Record<RoleKey, string[]>> = {
  superAdmin: ['Celery', 'NATS'],
};

/** Menu labels shown as links in the sidebar (an inert, greyed item is not a menu the user can use). */
export async function visibleMenus(page: Page): Promise<string[]> {
  const nav = page.locator('aside nav');
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  // The menus appear once the permission check has answered: wait for the list to settle.
  let last = '';
  await expect
    .poll(async () => {
      const now = (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim()).filter(Boolean).join('|');
      const settled = now === last;
      last = now;
      return settled;
    }, { intervals: [500, 500, 1000], timeout: 15_000 })
    .toBe(true);
  return last.split('|').filter((t) => t !== 'Home' && MENUS.some((m) => m.name === t));
}

/** POST /v1.0/permissions-check for the given URIs and methods, answered as uri -> method -> allowed. */
export async function permissionsCheck(page: Page, checks: [uri: string, method: string][]): Promise<Record<string, Record<string, boolean>>> {
  const request: Record<string, string[]> = {};
  for (const [uri, method] of checks) (request[uri] ??= []).push(method);
  const result = await backendFetch(page, '/v1.0/permissions-check', { method: 'POST', data: { requests_to_check: request } });
  expect(result.status, 'POST /v1.0/permissions-check').toBe(200);
  return ((result.body as { results?: Record<string, Record<string, boolean>> }).results ?? {});
}

/** Whether the server allows each menu: the real API where the menu has one, else permissions-check. */
export async function serverAllows(page: Page): Promise<Record<string, boolean>> {
  const answers = await permissionsCheck(page, MENUS.map((m) => m.check));
  const allowed: Record<string, boolean> = {};
  for (const m of MENUS) {
    allowed[m.name] = m.api ? (await backendFetch(page, m.api)).status < 300 : Boolean(answers[m.check[0]]?.[m.check[1]]);
  }
  return allowed;
}

/** Whether a page opened by URL is refused: sent elsewhere (Home, login) or shows a not-authorised message. */
export async function pageRefused(page: Page, path: string): Promise<{ refused: boolean; landed: string }> {
  await page.goto(path);
  let landed = '';
  const refused = await expect
    .poll(async () => {
      landed = new URL(page.url()).pathname;
      if (landed !== path && !landed.startsWith(`${path}/`)) return true;
      return page.getByText(/not available|not authori[sz]ed|not allowed|access denied|forbidden|don't have (access|permission)/i).first().isVisible();
    }, { timeout: 15_000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  return { refused, landed };
}

/**
 * Super Admin: picks a tenant in the sidebar's Tenant drop-down ('All tenants', or a tenant by its slug, e.g. 'm8flow').
 * Writes (create, publish, start) need a tenant selected.
 */
export async function selectTenantAsSuperAdmin(page: Page, slugOrAll: string): Promise<void> {
  let label = slugOrAll;
  if (slugOrAll !== 'All tenants') {
    const registry = await backendFetch(page, '/v1.0/m8flow/tenants');
    const body = registry.body as { results?: { name: string; slug: string }[] } | { name: string; slug: string }[];
    const rows = Array.isArray(body) ? body : body?.results ?? [];
    label = rows.find((t) => t.slug === slugOrAll)?.name ?? slugOrAll;
  }
  // An open dialog hides the sidebar from assistive roles: start from Home then.
  if (!(await page.locator('aside').count()) || (await page.getByRole('dialog').count())) await page.goto('/');
  const picker = page.locator('aside').getByRole('combobox', { name: 'Tenant', exact: true });
  await expect(picker).toBeVisible();
  if ((await picker.innerText()).trim() === label) return;
  await picker.click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(picker).toContainText(label);
}
