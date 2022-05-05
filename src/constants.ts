import { ErrorCode, LocalRestApiSettings } from "./types";

export const CERT_NAME = "obsidian-local-rest-api.crt";

export const HOSTNAME = "127.0.0.1";

export const DEFAULT_SETTINGS: LocalRestApiSettings = {
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: false,
  qkIniPath: "C:\\Users\\Administrator\\AppData\\Local\\Quicker\\data\\SMEditPro.ini",
  uidFieldName: "id",
  toMdFolderPath: "C:\\default\\",
  SMQAdelimiter: "---",
  titleInTimeout: 15000,
  StatusBarItemDisplay: "none",
  O2SInputPath: "editing.md",
  double_chain_reference_actionId: "95fa3d7a-8f25-4167-b03c-c5a7a06d1c6a"
};

export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ApiKeyAuthorizationRequired]: "Authorization required.  Find your API Key in the 'Local REST API' section of your Obsidian settings.",
  [ErrorCode.ContentTypeSpecificationRequired]: "Content-Type header required; this API accepts data in multiple content-types and you must indicate the content-type of your request body via the Content-Type header.",
  [ErrorCode.InvalidContentInsertionPositionValue]: "Invalid 'Content-Insertion-Position' header value.",
  [ErrorCode.InvalidContentForContentType]: "Your request body could not be processed as the content-type specified in your Content-Type header.",
  [ErrorCode.InvalidHeadingHeader]: "No heading in specified file could be found matching the heading specified in 'Heading' header.",
  [ErrorCode.MissingHeadingHeader]: "'Heading' header is required for identifying where to insert content.",
  [ErrorCode.PeriodDoesNotExist]: "Specified period does not exist.",
  [ErrorCode.PeriodIsNotEnabled]: "Specified period is not enabled.",
  [ErrorCode.PeriodicNoteDoesNotExist]: "Periodic note does not exist for the specified period.",
  [ErrorCode.RequestMethodValidOnlyForFiles]: "Request method is valid only for file paths, not directories.",
  [ErrorCode.TextOrByteContentEncodingRequired]: "Incoming content must be sent with a bytes or text content encoding.  Be sure to set a Content-type header matching application/* or text/*.",
  [ErrorCode.InvalidFilterQuery]: "The query you provided could not be processed.",
  40520: "",
  50000: "",
  50530: ""
};

export enum ContentTypes {
  json = "application/json",
  markdown = "text/markdown",
  olrapiNoteJson = "application/vnd.olrapi.note+json",
  jsonLogic = "application/vnd.olrapi.jsonlogic+json",
}
