// Bulk-invite CSV parsing shared by the API route and the self-service page, so the
// page can show which rows grant tenant-admin before anything is submitted (#244).
// Keep this module free of server-only imports: it ships in the client bundle.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const BULK_ROLES: ReadonlySet<string> = new Set(["tenant_admin", "accountadmin", "reviewer", "analyst", "viewer"]);
// `workspace_admin` was renamed to `accountadmin`; CSVs prepared before the rename still use it.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CsvRecord = { line: number; fields: string[]; unterminated: boolean };

/**
 * Quote-aware tokeniser over the whole text, so a quoted cell may contain
 * commas, doubled quotes ("") and line breaks. Each record carries the
 * physical (1-based) line it starts on; records with no content are skipped.
 * A quote left open at end of input marks the final record `unterminated`.
 */
function parseCsvRecords(text:string): CsvRecord[] {
  const records:CsvRecord[]=[]; let fields:string[]=[]; let value=""; let raw=""; let quoted=false; let line=1; let startLine=1;
  const endRecord=(unterminated:boolean)=>{
    fields.push(value.trim());
    if(unterminated||fields.length>1||raw.trim()) records.push({line:startLine,fields,unterminated});
    fields=[]; value=""; raw="";
  };
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(char==="\n") line++;
    if(quoted){
      raw+=char;
      if(char==='"'){ if(text[i+1]==='"'){value+='"';raw+='"';i++;} else quoted=false; } else value+=char;
    } else if(char==='"'){ quoted=true; raw+=char; }
    else if(char===","){ fields.push(value.trim()); value=""; raw+=char; }
    else if(char==="\n"||(char==="\r"&&text[i+1]==="\n")){ if(char==="\r"){i++;line++;} endRecord(false); startLine=line; }
    else { value+=char; raw+=char; }
  }
  if(quoted) endRecord(true); else if(fields.length>0||raw.length>0) endRecord(false);
  return records;
}
export type BulkInviteRow = { row:number; name:string; email:string; roleName:string; workspaceId:string; reason:string };
export function parseBulkInviteCsv(csv:string): { rows:BulkInviteRow[]; errors:Array<{row:number;error:string}> } {
  const records=parseCsvRecords(csv.replace(/^\uFEFF/,""));
  if(records.length<2) return {rows:[],errors:[{row:records[0]?.line??1,error:"CSV requires a header and at least one data row"}]};
  const headerRecord=records[0];
  if(headerRecord.unterminated) return {rows:[],errors:[{row:headerRecord.line,error:"Invalid CSV header"}]};
  const header=headerRecord.fields.map((v)=>v.toLowerCase().replaceAll("_",""));
  const index=(...names:string[])=>header.findIndex((value)=>names.includes(value));
  const nameIndex=index("name","fullname"),emailIndex=index("email","emailaddress"),roleIndex=index("role","rolename"),workspaceIndex=index("workspace","workspaceid"),reasonIndex=index("reason");
  if(emailIndex<0||roleIndex<0||workspaceIndex<0) return {rows:[],errors:[{row:headerRecord.line,error:"Required columns: email, role, workspaceId"}]};
  const rows:BulkInviteRow[]=[]; const errors:Array<{row:number;error:string}>=[];
  for(const record of records.slice(1)){const rowNumber=record.line;if(record.unterminated){errors.push({row:rowNumber,error:"Invalid CSV row"});continue;}const values=record.fields;const email=(values[emailIndex]??"").trim().toLowerCase(),rawRole=(values[roleIndex]??"").trim(),roleName=rawRole==="workspace_admin"?"accountadmin":rawRole,workspaceId=(values[workspaceIndex]??"").trim(),name=nameIndex>=0?(values[nameIndex]??"").trim():"",reason=reasonIndex>=0?(values[reasonIndex]??"").trim():"Bulk enterprise onboarding";if(!EMAIL.test(email)||!BULK_ROLES.has(roleName)||!UUID.test(workspaceId)||reason.length<3||reason.length>1000){errors.push({row:rowNumber,error:"Invalid email, role, workspaceId, or reason"});continue;}rows.push({row:rowNumber,name,email,roleName,workspaceId,reason});}
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
