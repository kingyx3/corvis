// Bulk-invite CSV parsing shared by the API route and the self-service page, so the
// page can show which rows grant tenant-admin before anything is submitted (#244).
// Keep this module free of server-only imports: it ships in the client bundle.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BULK_ROLES = new Set(["tenant_admin", "workspace_admin", "reviewer", "analyst", "viewer"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCsvLine(line: string): string[] {
  const fields:string[]=[]; let value=""; let quoted=false;
  for(let i=0;i<line.length;i++){ const char=line[i]; if(char==='"'){ if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted; } else if(char===','&&!quoted){fields.push(value.trim());value="";} else value+=char; }
  if(quoted) throw new Error("unterminated_quote"); fields.push(value.trim()); return fields;
}
export type BulkInviteRow = { row:number; name:string; email:string; roleName:string; workspaceId:string; reason:string };
export function parseBulkInviteCsv(csv:string): { rows:BulkInviteRow[]; errors:Array<{row:number;error:string}> } {
  const lines=csv.replace(/^﻿/,"").split(/\r?\n/).filter((line)=>line.trim());
  if(lines.length<2) return {rows:[],errors:[{row:1,error:"CSV requires a header and at least one data row"}]};
  let header:string[]; try{header=parseCsvLine(lines[0]).map((v)=>v.toLowerCase().replaceAll("_",""));}catch{return {rows:[],errors:[{row:1,error:"Invalid CSV header"}]};}
  const index=(...names:string[])=>header.findIndex((value)=>names.includes(value));
  const nameIndex=index("name","fullname"),emailIndex=index("email","emailaddress"),roleIndex=index("role","rolename"),workspaceIndex=index("workspace","workspaceid"),reasonIndex=index("reason");
  if(emailIndex<0||roleIndex<0||workspaceIndex<0) return {rows:[],errors:[{row:1,error:"Required columns: email, role, workspaceId"}]};
  const rows:BulkInviteRow[]=[]; const errors:Array<{row:number;error:string}>=[];
  for(let i=1;i<lines.length;i++){const rowNumber=i+1;try{const values=parseCsvLine(lines[i]);const email=(values[emailIndex]??"").trim().toLowerCase(),roleName=(values[roleIndex]??"").trim(),workspaceId=(values[workspaceIndex]??"").trim(),name=nameIndex>=0?(values[nameIndex]??"").trim():"",reason=reasonIndex>=0?(values[reasonIndex]??"").trim():"Bulk enterprise onboarding";if(!EMAIL.test(email)||!BULK_ROLES.has(roleName)||!UUID.test(workspaceId)||reason.length<3||reason.length>1000){errors.push({row:rowNumber,error:"Invalid email, role, workspaceId, or reason"});continue;}rows.push({row:rowNumber,name,email,roleName,workspaceId,reason});}catch{errors.push({row:rowNumber,error:"Invalid CSV row"});}}
  return {rows,errors};
}

/** Valid rows that would grant organization-wide administration. */
export function tenantAdminRows(csv:string): BulkInviteRow[] {
  return parseBulkInviteCsv(csv).rows.filter((row)=>row.roleName==="tenant_admin");
}

const BULK_INVITE_ERROR_TEXT: Record<string,string> = {
  tenant_admin_confirmation_required: "Grants organization admin; confirm the tenant-admin rows and submit again.",
  invalid_invitation: "The invitation details are not valid.",
  invitation_already_pending: "An invitation for this address is already pending.",
  workspace_not_found: "The workspace does not exist in your organization.",
  invitation_failed: "The invitation could not be created. Try again or contact support.",
};

/** Human-readable text for the stable per-row error codes; free-text parse errors pass through. */
export function bulkInviteErrorText(code:string): string {
  return BULK_INVITE_ERROR_TEXT[code] ?? code;
}
