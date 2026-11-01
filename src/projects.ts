import type { Json } from "./api";

export interface CodexProject {
  id: string;
  name: string;
  rootPaths: string[];
  native: boolean;
}
export interface ProjectCatalog {
  data: CodexProject[];
  assignments: Record<string, string | null>;
  workspaceRootHints: Record<string, string>;
  legacyAssignments: boolean;
  nativeProjects: boolean;
}
export const EMPTY_PROJECT_CATALOG: ProjectCatalog = {
  data: [], assignments: {}, workspaceRootHints: {}, legacyAssignments: false, nativeProjects: false,
};
export function projectCatalog(value: Json): ProjectCatalog {
  if (!Array.isArray(value.data) || value.data.some((project: Json) =>
    typeof project?.id !== "string" || typeof project.name !== "string" ||
    !Array.isArray(project.rootPaths) || project.rootPaths.some((root: unknown) => typeof root !== "string") ||
    typeof project.native !== "boolean")) throw new Error("执行电脑返回了无效的 Codex 项目列表");
  if (!value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments) ||
    Object.values(value.assignments).some(id => id !== null && typeof id !== "string") ||
    !value.workspaceRootHints || typeof value.workspaceRootHints !== "object" || Array.isArray(value.workspaceRootHints) ||
    Object.values(value.workspaceRootHints).some(root => typeof root !== "string") ||
    typeof value.legacyAssignments !== "boolean" || typeof value.nativeProjects !== "boolean") {
    throw new Error("执行电脑返回了无效的 Codex 项目归属");
  }
  const ids = new Set(value.data.map((project: CodexProject) => project.id));
  if (ids.size !== value.data.length) throw new Error("Codex 项目列表包含重复标识");
  return value as ProjectCatalog;
}
function pathKey(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}
function containsPath(root: string, path: string) {
  const parent = pathKey(root), child = pathKey(path);
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
export function projectForThread(thread: Json, catalog: ProjectCatalog): CodexProject | undefined {
  if (typeof thread.projectId === "string") return catalog.data.find(project => project.id === thread.projectId);
  if (Object.hasOwn(catalog.assignments, thread.id)) {
    return catalog.data.find(project => project.id === catalog.assignments[thread.id]);
  }
  // Native unassigned threads stay unassigned unless the desktop has an explicit legacy membership.
  if (catalog.nativeProjects && Object.hasOwn(thread, "projectId")) return undefined;
  if (!catalog.legacyAssignments) return undefined;
  const path = catalog.workspaceRootHints[thread.id] || thread.cwd;
  if (typeof path !== "string" || !path) return undefined;
  // Legacy desktop projects use their saved roots, never arbitrary session directories.
  return catalog.data.flatMap(project => project.rootPaths.filter(root => containsPath(root, path)).map(root => ({ project, length: pathKey(root).length })))
    .sort((left, right) => right.length - left.length)[0]?.project;
}
export interface ProjectGroup {
  id: string;
  name: string;
  rootPaths: string[];
  project?: CodexProject;
  threads: Json[];
}
export function groupProjectThreads(threads: Json[], catalog: ProjectCatalog, search: string): ProjectGroup[] {
  const groups: ProjectGroup[] = catalog.data.map(project => ({
    id: project.id, name: project.name, rootPaths: project.rootPaths, project, threads: [],
  }));
  const indexed = new Map(groups.map(group => [group.id, group]));
  const unassigned: ProjectGroup = { id: "unassigned", name: "未分组会话", rootPaths: [], threads: [] };
  for (const thread of threads) {
    const project = projectForThread(thread, catalog);
    (project ? indexed.get(project.id)! : unassigned).threads.push(thread);
  }
  const query = search.trim().toLocaleLowerCase();
  const visible = query ? groups.filter(group => group.threads.length || group.name.toLocaleLowerCase().includes(query)) : groups;
  return unassigned.threads.length ? [...visible, unassigned] : visible;
}
