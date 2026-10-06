import { correlationId } from "@/platform/http/api/http";
import { getServerConfig } from "@/platform/config/config";
import { postgres, withTransaction } from "@/platform/database/postgres";
import { authenticateScim, createScimUser, listScimUsers, scimErrorResponse, ScimError } from "@/modules/identity-access/server/directory/scim";

export async function GET(request:Request){try{const db=postgres(getServerConfig().databaseDsn);const config=await authenticateScim(request,db);const url=new URL(request.url);const base=`${url.origin}/api/v1/scim/v2/Users`;
  const startIndex=Number(url.searchParams.get("startIndex")??"1");const count=Number(url.searchParams.get("count")??String(200));
  const {resources,totalResults,startIndex:resolvedStartIndex}=await listScimUsers(config,base,url.searchParams.get("filter"),db,startIndex,count);
  return Response.json({schemas:["urn:ietf:params:scim:api:messages:2.0:ListResponse"],totalResults,startIndex:resolvedStartIndex,itemsPerPage:resources.length,Resources:resources},{headers:{"cache-control":"no-store"}});}catch(error){return scimErrorResponse(error,correlationId(request));}}

export async function POST(request:Request){try{const db=postgres(getServerConfig().databaseDsn);const config=await authenticateScim(request,db);let input:Record<string,unknown>;try{const value=await request.json();if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();input=value as Record<string,unknown>;}catch{throw new ScimError(400,"invalidSyntax","SCIM JSON object required");}const base=`${new URL(request.url).origin}/api/v1/scim/v2/Users`;const resource=await withTransaction(db,(tx)=>createScimUser(config,input,base,correlationId(request),tx));return Response.json({schemas:["urn:ietf:params:scim:schemas:core:2.0:User"],...resource},{status:201,headers:{location:resource.meta.location,"cache-control":"no-store"}});}catch(error){return scimErrorResponse(error,correlationId(request));}}
