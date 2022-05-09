import {
  App,
  Command,
  TFile,
  apiVersion,
  PluginManifest,
  prepareSimpleSearch,
  CachedMetadata,
  parseFrontMatterEntry,
  Notice,
} from "obsidian";
import periodicNotes from "obsidian-daily-notes-interface";

import express from "express";
import http from "http";
import cors from "cors";
import mime from "mime";
import bodyParser from "body-parser";
import jsonLogic from "json-logic-js";
import responseTime from "response-time";
import queryString from "query-string";
import WildcardRegexp from "glob-to-regexp";
import {
  ErrorCode,
  CannedResponse,
  ErrorResponseDescriptor,
  LocalRestApiSettings,
  PeriodicNoteInterface,
  SearchResponseItem,
  SearchContext,
  SearchJsonResponseItem,
  FileMetadataObject,
  SearchUidResponseItem,
} from "./types";
import { findHeadingBoundary } from "./utils";
import { CERT_NAME, ContentTypes, ERROR_CODE_MESSAGES } from "./constants";
import { InputTitlePrompt } from "./main";
import { md } from "node-forge";

export default class RequestHandler {
  app: App;
  api: express.Express;
  manifest: PluginManifest;
  settings: LocalRestApiSettings;
  lastSearchUidPath: string;
  constructor(
    app: App,
    manifest: PluginManifest,
    settings: LocalRestApiSettings
  ) {
    this.app = app;
    this.manifest = manifest;
    this.api = express();
    this.settings = settings;

    this.api.set("json spaces", 2);

    jsonLogic.add_operation(
      "glob",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          const glob = WildcardRegexp(pattern);
          return glob.test(field);
        }
        return false;
      }
    );
    jsonLogic.add_operation(
      "regexp",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          const rex = new RegExp(pattern);
          return rex.test(field);
        }
        return false;
      }
    );
  }

  requestIsAuthenticated(req: express.Request): boolean {
    const authorizationHeader = req.get("Authorization");
    if (authorizationHeader === `Bearer ${this.settings.apiKey}`) {
      return true;
    }
    return false;
  }

  async authenticationMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    const authenticationExemptRoutes: string[] = ["/", `/${CERT_NAME}`];

    if (
      !authenticationExemptRoutes.includes(req.path) &&
      !this.requestIsAuthenticated(req)
    ) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ApiKeyAuthorizationRequired,
      });
      return;
    }

    next();
  }

  async getFileMetadataObject(file: TFile): Promise<FileMetadataObject> {
    const cache = this.app.metadataCache.getFileCache(file);

    // Gather frontmatter & strip out positioning information
    const frontmatter = { ...(cache.frontmatter ?? {}) };
    delete frontmatter.position; // This just adds noise

    // Gather both in-line tags (hash'd) & frontmatter tags; strip
    // leading '#' from them if it's there, and remove duplicates
    const directTags = (cache.tags ?? []).map((tag) => tag.tag) ?? [];
    const frontmatterTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : [];
    const filteredTags: string[] = [...frontmatterTags, ...directTags]
      .map((tag) => tag.replace(/^#/, ""))
      .filter((value, index, self) => self.indexOf(value) === index);

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: await this.app.vault.cachedRead(file),
    };
  }

  getResponseMessage({
    statusCode = 400,
    message,
    errorCode,
  }: ErrorResponseDescriptor): string {
    let errorMessages: string[] = [];
    if (errorCode) {
      errorMessages.push(ERROR_CODE_MESSAGES[errorCode]);
    } else {
      errorMessages.push(http.STATUS_CODES[statusCode]);
    }
    if (message) {
      errorMessages.push(message);
    }

    return errorMessages.join(" ");
  }

  getStatusCode({ statusCode, errorCode }: ErrorResponseDescriptor): number {
    if (statusCode) {
      return statusCode;
    }
    return Math.floor(errorCode / 100);
  }

  returnCannedResponse(
    res: express.Response,
    { statusCode, message, errorCode }: ErrorResponseDescriptor
  ): void {
    const response: CannedResponse = {
      message: this.getResponseMessage({ statusCode, message, errorCode }),
      errorCode: errorCode ?? statusCode * 100,
    };

    res.statusCode = this.getStatusCode({ statusCode, errorCode });

    res.json(response);
  }

  root(req: express.Request, res: express.Response): void {
    res.statusCode = 200;

    res.json({
      status: "OK",
      versions: {
        obsidian: apiVersion,
        self: this.manifest.version,
      },
      service: "Obsidian Local REST API",
      authenticated: this.requestIsAuthenticated(req),
    });
  }

  async _vaultGet(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      const files = [
        ...new Set(
          this.app.vault
            .getFiles()
            .map((e) => e.path)
            .filter((filename) => filename.startsWith(path))
            .map((filename) => {
              const subPath = filename.slice(path.length);
              if (subPath.indexOf("/") > -1) {
                return subPath.slice(0, subPath.indexOf("/") + 1);
              }
              return subPath;
            })
        ),
      ];
      files.sort();

      res.json({
        files: files,
      });
    } else {
      const exists = await this.app.vault.adapter.exists(path);

      if (exists) {
        const content = await this.app.vault.adapter.read(path);
        const mimeType = mime.lookup(path);

        res.set({
          "Content-Disposition": `attachment; filename="${encodeURI(
            path
          ).replace(",", "%2C")}"`,
          "Content-Type":
            `${mimeType}` +
            (mimeType == ContentTypes.markdown ? "; charset=UTF-8" : ""),
        });

        if (req.headers.accept === ContentTypes.olrapiNoteJson) {
          const file = this.app.vault.getAbstractFileByPath(path) as TFile;
          res.setHeader("Content-Type", ContentTypes.olrapiNoteJson);
          res.send(
            JSON.stringify(await this.getFileMetadataObject(file), null, 2)
          );
          return;
        }
        res.send(content);
      } else {
        this.returnCannedResponse(res, {
          statusCode: 404,
        });
        return;
      }
    }
  }

  async vaultGet(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    return this._vaultGet(path, req, res);
  }

  async _vaultPut(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    if (typeof req.body != "string") {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    await this.app.vault.adapter.write(path, req.body);

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPut(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    return this._vaultPut(path, req, res);
  }

  async _vaultPatch(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const headingBoundary = req.get("Heading-Boundary") || "::";
    const heading = (req.get("Heading") || "")
      .split(headingBoundary)
      .filter(Boolean);
    const contentPosition = req.get("Content-Insertion-Position");
    let insert = false;

    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }
    if (contentPosition === undefined) {
      insert = false;
    } else if (contentPosition === "beginning") {
      insert = true;
    } else if (contentPosition === "end") {
      insert = false;
    } else {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidContentInsertionPositionValue,
      });
      return;
    }
    if (typeof req.body != "string") {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    if (!heading.length) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.MissingHeadingHeader,
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.returnCannedResponse(res, {
        statusCode: 404,
      });
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const position = findHeadingBoundary(cache, heading);

    if (!position) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidHeadingHeader,
      });
      return;
    }

    const fileContents = await this.app.vault.read(file);
    const fileLines = fileContents.split("\n");

    fileLines.splice(
      insert === false
        ? position.end?.line ?? fileLines.length
        : position.start.line + 1,
      0,
      req.body
    );

    const content = fileLines.join("\n");

    await this.app.vault.adapter.write(path, content);

    res.statusCode = 200;
    res.send(content);
  }

  async vaultPatch(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    return this._vaultPatch(path, req, res);
  }

  async _vaultPost(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    if (typeof req.body != "string") {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.TextOrByteContentEncodingRequired,
      });
      return;
    }

    let fileContents = "";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      fileContents = await this.app.vault.read(file);
      if (!fileContents.endsWith("\n")) {
        fileContents += "\n";
      }
    }

    fileContents += req.body;

    await this.app.vault.adapter.write(path, fileContents);

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultPost(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    return this._vaultPost(path, req, res);
  }

  async _vaultDelete(
    path: string,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    if (!path || path.endsWith("/")) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.RequestMethodValidOnlyForFiles,
      });
      return;
    }

    const pathExists = await this.app.vault.adapter.exists(path);
    if (!pathExists) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    await this.app.vault.adapter.remove(path);
    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }

  async vaultDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const path = req.params[0];

    return this._vaultDelete(path, req, res);
  }

  getPeriodicNoteInterface(): Record<string, PeriodicNoteInterface> {
    return {
      daily: {
        settings: periodicNotes.getDailyNoteSettings(),
        loaded: periodicNotes.appHasDailyNotesPluginLoaded(),
        create: periodicNotes.createDailyNote,
        get: periodicNotes.getDailyNote,
        getAll: periodicNotes.getAllDailyNotes,
      },
      weekly: {
        settings: periodicNotes.getWeeklyNoteSettings(),
        loaded: periodicNotes.appHasWeeklyNotesPluginLoaded(),
        create: periodicNotes.createWeeklyNote,
        get: periodicNotes.getWeeklyNote,
        getAll: periodicNotes.getAllWeeklyNotes,
      },
      monthly: {
        settings: periodicNotes.getMonthlyNoteSettings(),
        loaded: periodicNotes.appHasMonthlyNotesPluginLoaded(),
        create: periodicNotes.createMonthlyNote,
        get: periodicNotes.getMonthlyNote,
        getAll: periodicNotes.getAllMonthlyNotes,
      },
      quarterly: {
        settings: periodicNotes.getQuarterlyNoteSettings(),
        loaded: periodicNotes.appHasQuarterlyNotesPluginLoaded(),
        create: periodicNotes.createQuarterlyNote,
        get: periodicNotes.getQuarterlyNote,
        getAll: periodicNotes.getAllQuarterlyNotes,
      },
      yearly: {
        settings: periodicNotes.getYearlyNoteSettings(),
        loaded: periodicNotes.appHasYearlyNotesPluginLoaded(),
        create: periodicNotes.createYearlyNote,
        get: periodicNotes.getYearlyNote,
        getAll: periodicNotes.getAllYearlyNotes,
      },
    };
  }

  periodicGetInterface(
    period: string
  ): [PeriodicNoteInterface | null, ErrorCode | null] {
    const periodic = this.getPeriodicNoteInterface();
    if (!periodic[period]) {
      return [null, ErrorCode.PeriodDoesNotExist];
    }
    if (!periodic[period].loaded) {
      return [null, ErrorCode.PeriodIsNotEnabled];
    }

    return [periodic[period], null];
  }

  periodicGetNote(periodName: string): [TFile | null, ErrorCode | null] {
    const [period, err] = this.periodicGetInterface(periodName);
    if (err) {
      return [null, err];
    }

    const now = (window as any).moment(Date.now());
    const all = period.getAll();

    const file = period.get(now, all);
    if (!file) {
      return [null, ErrorCode.PeriodicNoteDoesNotExist];
    }

    return [file, null];
  }

  async periodicGetOrCreateNote(
    periodName: string
  ): Promise<[TFile | null, ErrorCode | null]> {
    let [file, err] = this.periodicGetNote(periodName);
    if (err === ErrorCode.PeriodicNoteDoesNotExist) {
      const [period] = this.periodicGetInterface(periodName);
      const now = (window as any).moment(Date.now());

      file = await period.create(now);

      const metadataCachePromise = new Promise<CachedMetadata>((resolve) => {
        let cache: CachedMetadata = null;

        const interval: ReturnType<typeof setInterval> = setInterval(() => {
          cache = this.app.metadataCache.getFileCache(file);
          if (cache) {
            clearInterval(interval);
            resolve(cache);
          }
        }, 100);
      });
      await metadataCachePromise;
    } else if (err) {
      return [null, err];
    }

    return [file, null];
  }

  periodicRedirectToVault(
    file: TFile,
    req: express.Request,
    res: express.Response,
    handler: (path: string, req: express.Request, res: express.Response) => void
  ): void {
    const path = file.path;
    res.set("Content-Location", encodeURI(path));

    return handler(path, req, res);
  }

  async periodicGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const [file, err] = this.periodicGetNote(req.params.period);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.periodicRedirectToVault(
      file,
      req,
      res,
      this._vaultGet.bind(this)
    );
  }

  async periodicPut(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const [file, err] = await this.periodicGetOrCreateNote(req.params.period);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.periodicRedirectToVault(
      file,
      req,
      res,
      this._vaultPut.bind(this)
    );
  }

  async periodicPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const [file, err] = await this.periodicGetOrCreateNote(req.params.period);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.periodicRedirectToVault(
      file,
      req,
      res,
      this._vaultPost.bind(this)
    );
  }

  async periodicPatch(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const [file, err] = await this.periodicGetOrCreateNote(req.params.period);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.periodicRedirectToVault(
      file,
      req,
      res,
      this._vaultPatch.bind(this)
    );
  }

  async periodicDelete(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const [file, err] = this.periodicGetNote(req.params.period);
    if (err) {
      this.returnCannedResponse(res, { errorCode: err });
      return;
    }

    return this.periodicRedirectToVault(
      file,
      req,
      res,
      this._vaultDelete.bind(this)
    );
  }

  async commandGet(req: express.Request, res: express.Response): Promise<void> {
    const commands: Command[] = [];
    for (const commandName in this.app.commands.commands) {
      commands.push({
        id: commandName,
        name: this.app.commands.commands[commandName].name,
      });
    }

    const commandResponse = {
      commands: commands,
    };

    res.json(commandResponse);
  }

  async commandPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const cmd = this.app.commands.commands[req.params.commandId];

    if (!cmd) {
      this.returnCannedResponse(res, { statusCode: 404 });
      return;
    }

    try {
      this.app.commands.executeCommandById(req.params.commandId);
    } catch (e) {
      this.returnCannedResponse(res, { statusCode: 500, message: e.message });
      return;
    }

    this.returnCannedResponse(res, { statusCode: 204 });
    return;
  }
  /** 试试 */
  async searchSimplePost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const results: SearchResponseItem[] = [];

    const query: string = req.query.query as string;
    const contextLength: number =
      parseInt(req.query.contextLength as string, 10) ?? 100;
    const search = prepareSimpleSearch(query);

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cachedContents = await this.app.vault.cachedRead(file);
      const result = search(cachedContents);
      if (result) {
        const contextMatches: SearchContext[] = [];
        for (const match of result.matches) {
          contextMatches.push({
            match: {
              start: match[0],
              end: match[1],
            },
            context: cachedContents.slice(
              Math.max(match[0] - contextLength, 0),
              match[1] + contextLength
            ),
          });
        }

        results.push({
          filename: file.path,
          score: result.score,
          matches: contextMatches,
        });
      }
    }

    results.sort((a, b) => (a.score > b.score ? 1 : -1));
    res.json(results);
  }

  async searchUidPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {

    this.settings.StatusBarItemDisplay = "block";

    // v1 to v2
    // const uidFieldName: string = req.query.uidfieldname as string;
    // const toMdFolderPath: string = req.query.tomdfolderpath as string;//SM2OBFolderPath
    // const SMQAdelimiter: string = req.query.smqadelimiter as string;//QA 之间的分割符号

    //v2
    const uidFieldName: string = this.settings.uidFieldName;
    const toMdFolderPath: string = this.settings.toMdFolderPath;
    const SMQAdelimiter: string = this.settings.SMQAdelimiter;

    const query: string = req.query.query as string;//要查询的元素id 等于 editedEleID
    const field_domain: number = parseInt(req.query.field_domain as string, 10)

    //decodeURIComponent

    let resUid: string = "";

    try {
      if (this.lastSearchUidPath == undefined) {
        resUid = this.getFileFromUID(this.pad(query, 8), uidFieldName)?.path;
      } else {
        let md_txt = await this.app.vault.adapter.read(this.lastSearchUidPath);
        let yaml_txt = "";
        var extractIdRegexObj = new RegExp(uidFieldName + ": ?(.+)");
        let md_id = "";
        if (md_txt.match(/^(---)((.|\s)*?)(---)/) != null) {
          yaml_txt = md_txt.match(/^(---)((.|\s)*?)(---)/)[2];
          yaml_txt = yaml_txt.trim();
          md_id = yaml_txt.match(extractIdRegexObj)[1];
          if (this.pad(query, 8) == md_id) {//匹配lastSearchUidPath 
            resUid = this.lastSearchUidPath;
          } else {//不匹配重新查询
            resUid = this.getFileFromUID(this.pad(query, 8), uidFieldName)?.path;

          }
        } else {
          new Notice("error!" + this.lastSearchUidPath + ": 此markdown中没有Uid字段")
          this.returnCannedResponse(res, {
            errorCode: ErrorCode.NoFindUidField,
            message: this.lastSearchUidPath + ": 此markdown中没有Uid字段",

          });
        }
      }
    } catch (error) {
      this.lastSearchUidPath = undefined;
      new Notice("error! " + "this.lastSearchUidPath" + error)
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.UncategorizedError,
        message: "error! " + "this.lastSearchUidPath" + error,

      });
    }

    if (resUid != undefined) {
      //let outputPath = this.app.vault.adapter.basePath + "\\" + resUid.replaceAll("/", "\\");
      let outputPath = resUid;
      //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 有md路径
      await this.persistentMd(this.settings.O2SInputPath, outputPath, field_domain, SMQAdelimiter, true, res);
      window.setTimeout(() => this.settings.StatusBarItemDisplay = "none", 2500);//2.5s 后消失
    } else {//根据uid 没有查询到文件
      //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 没有md路径
      let prompt = new InputTitlePrompt(this.app, async (result) => {

        new Notice(`你输入的标题为, ${result}!`);
        await this.createPersistentMd(this.settings.O2SInputPath, field_domain, toMdFolderPath, SMQAdelimiter, query, uidFieldName, result, true, res);
        this.settings.StatusBarItemDisplay = "none";
      });

      let timeout = window.setTimeout(() => this.operationTimeOut(prompt, timeout, true, res), this.settings.titleInTimeout)
      prompt.setTimeOutNum(timeout);
      prompt.open();


    }





  }
  /**
   * 
   * @param workspacetempmd 临时的md文件地址 
   * @param field_domain 字字段的序列 或者说是下标
   * @param toMdFolderPath SM2OBFolderPath 持久化后的md文件夹路径
   * @param SMQAdelimiter QA之间的分割符号
   * @param editedEleID 当前被编辑的元素id
   * @param uidFieldName uid 字段名称 表示唯一身份的字段名称
   * @param mdtitle md文档的title
   */
  async createPersistentMd(workspacetempmd: string, field_domain: number, toMdFolderPath: string, SMQAdelimiter: string, editedEleID: string, uidFieldName: string, mdtitle: string, mode: boolean, res?: express.Response): Promise<void> {
    //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 没有md路径
    const result: SearchUidResponseItem = { path: "" };
    try {
      let fileContents = "";
      let qalist = new Array(2).fill('');

      let yaml_txt = "---\n" + uidFieldName + ": " + this.pad(editedEleID, 8) + "\n" + "preloadIframes: true\nenableLinks: true" + "\n" + "---\n";


      // const file = this.app.vault.getAbstractFileByPath(workspacetempmd) as TFile;
      // if (file instanceof TFile) {
      //   fileContents = await this.app.vault.read(file);
      // }

      //this.app.workspace.activeLeaf.view.save(); 没有元素对应的md 创建 那一刻 不需要 save()
      fileContents = await this.app.vault.adapter.read(workspacetempmd);
      qalist[field_domain] = fileContents;

      let md_txt = yaml_txt + "\n" + qalist[0].trim() + "\n\n" + SMQAdelimiter + "\n\n" + qalist[1].trim();
      let tmepfile = await this.app.vault.create((toMdFolderPath.endsWith("\\") ? toMdFolderPath + mdtitle + ".md" : toMdFolderPath + "\\" + mdtitle + ".md"), md_txt);

      if (mode) {
        this.lastSearchUidPath = tmepfile.path;
        result.path = "success";
        if (this.settings.IsNoticeSync) {
          new Notice(tmepfile.path + "\n" + "尝试同步..", 3000);
        }
        res.json(result);
      } else {
        window.open("quicker:runaction:" + this.settings.double_chain_reference_actionId + "?manualSync");
      }

    } catch (error) {
      new Notice("error!createPersistentMd失败\n:" + error);

      if (mode) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.UncategorizedError,
          message: "错误-createPersistentMd:" + error,

        });
      }

    }


  }
  /**
   * 
   * @param workspacetempmd 临时的md文件地址 
   * @param persimd 持久化md 后的md地址
   * @param field_domain 字字段的序列 或者说是下标
   * @param SMQAdelimiter QA之间的分割符号
   * @param editedEleID 当前被编辑的元素id
   */
  async persistentMd(workspacetempmd: string, persimd: string, field_domain: number, SMQAdelimiter: string, mode: boolean, res?: express.Response): Promise<void> {
    //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 有md路径
    const result: SearchUidResponseItem = { path: "" };
    try {

      let md_txt = "";
      let yaml_txt = "";
      let temp_md_txt = "";
      let qalist = new Array(2).fill('');
      // const file = this.app.vault.getAbstractFileByPath(persimd) as TFile;
      // if (file instanceof TFile) {
      //   md_txt = await this.app.vault.read(file);
      // }
      this.app.workspace.activeLeaf.view.save();
      md_txt = await this.app.vault.adapter.read(persimd);
      if (md_txt.match(/^(---)((.|\s)*?)(---)/) != null) {
        yaml_txt = md_txt.match(/^(---)((.|\s)*?)(---)/)[2];
        yaml_txt = yaml_txt.trim();
        yaml_txt = "---" + "\n" + yaml_txt + "\n---\n"
      }

      // const file2 = this.app.vault.getAbstractFileByPath(workspacetempmd) as TFile;
      // if (file2 instanceof TFile) {
      //   temp_md_txt = await this.app.vault.read(file2);
      // }

      temp_md_txt = await this.app.vault.adapter.read(workspacetempmd);

      // new Notice("临时工作路径" + workspacetempmd);
      // new Notice("当前激活模式的文件路径" + this.app.workspace.activeLeaf.view.file.path);
      // new Notice("激活类型" + this.app.workspace.getActiveViewOfType);
      // console.log(this.app.workspace.activeLeaf.view.data);

      md_txt = md_txt.replace(/^(---)(.|\s)*?(---)/, "");
      md_txt = md_txt.trim();
      qalist = md_txt.split(SMQAdelimiter);
      qalist[field_domain] = temp_md_txt;
      md_txt = yaml_txt + "\n" + qalist[0].trim() + "\n\n" + SMQAdelimiter + "\n\n" + qalist[1].trim();
      await this.app.vault.adapter.write(persimd, md_txt);


      if (mode) {
        this.lastSearchUidPath = persimd;
        result.path = "success";
        if (this.settings.IsNoticeSync) {
          new Notice(persimd + "\n" + "尝试同步..", 3000);
        }
        res.json(result);
      } else {
        window.open("quicker:runaction:" + this.settings.double_chain_reference_actionId + "?manualSync");
      }


    } catch (error) {
      new Notice("error!PersistentMd失败\n:" + error);
      if (mode) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.UncategorizedError,
          message: "错误-persistentMd:" + error,

        });
      }

    }


  }
  operationTimeOut(temp: InputTitlePrompt, timeout: number, mode: boolean, res?: express.Response) {
    // const result: SearchUidResponseItem = { path: "" };
    // result.path = "\\error!,operatortimeout";
    temp.close();
    console.log("输入markdown标题操作超时");
    window.clearTimeout(timeout);
    new Notice("输入markdown标题操作超时");
    if (mode) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.OperateTimeOut,
        message: "输入markdown标题操作超时",

      });
    }

    this.settings.StatusBarItemDisplay = "none";
    // res.json(result);
  }
  getFileFromUID(uid: string, key: string): TFile | undefined {
    const files = this.app.vault.getFiles();
    const idKey = key;
    var temp = files.find(file => parseFrontMatterEntry(this.app.metadataCache.getFileCache(file)?.frontmatter, idKey) == uid);

    //return files.find(file => parseFrontMatterEntry(this.app.metadataCache.getFileCache(file)?.frontmatter, idKey) == uid);
    return temp;
  }
  pad(num: string, size: number) {
    var s = "000000000" + num;
    return s.substr(s.length - size);
  }

  async searchGuiPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const results: SearchResponseItem[] = [];
    const query: string = req.query.query as string;
    const contextLength: number =
      parseInt(req.query.contextLength as string, 10) ?? 100;

    // Open the search panel and start a search
    this.app.internalPlugins
      // @ts-ignore
      .getPluginById("global-search")
      .instance.openGlobalSearch(query);
    const searchDom =
      // @ts-ignore
      this.app.workspace.getLeavesOfType("search")[0].view.dom;

    // Wait until the search is complete in the UI
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!searchDom.working) {
          resolve();
          return;
        }
        const interval = setInterval(() => {
          if (!searchDom.working) {
            clearInterval(interval);
            resolve();
          }
        }, 2000);
      }, 100);
    });

    for (const result of searchDom.children) {
      const matches: SearchContext[] = [];
      for (const match of result.result.content) {
        matches.push({
          match: {
            start: match[0],
            end: match[1],
          },
          context: result.content.slice(
            Math.max(match[0] - contextLength, 0),
            match[1] + contextLength
          ),
        });
      }

      results.push({
        filename: result.file.path,
        matches,
      });
    }

    res.json(results);
  }

  valueIsEmpty(value: unknown): boolean {
    if (value === undefined || value === null) {
      return false;
    } else if (Array.isArray(value)) {
      return value.length > 0;
    } else if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return Boolean(value);
  }

  async searchQueryPost(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const handlers: Record<
      string,
      (body: unknown, context: FileMetadataObject) => unknown
    > = {
      [ContentTypes.jsonLogic]: jsonLogic.apply,
    };
    const contentType = req.headers["content-type"];

    if (!handlers[contentType]) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.ContentTypeSpecificationRequired,
      });
      return;
    }

    const results: SearchJsonResponseItem[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileContext = await this.getFileMetadataObject(file);

      try {
        const output = handlers[contentType](req.body, fileContext);
        if (this.valueIsEmpty(output)) {
          results.push({
            filename: file.path,
            result: output,
          });
        }
      } catch (e) {
        this.returnCannedResponse(res, {
          errorCode: ErrorCode.InvalidFilterQuery,
          message: `${e.message} (while processing ${file.path})`,
        });
        return;
      }
    }

    res.json(results);
  }

  async openPost(req: express.Request, res: express.Response): Promise<void> {
    const path = req.params[0];

    const query = queryString.parseUrl(req.originalUrl, {
      parseBooleans: true,
    }).query;
    const newLeaf: boolean = Boolean(query.newLeaf);

    this.app.workspace.openLinkText(path, "/", newLeaf);

    res.json();
  }

  async certificateGet(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    res.set(
      "Content-type",
      `application/octet-stream; filename="${CERT_NAME}"`
    );
    res.statusCode = 200;
    res.send(this.settings.crypto.cert);
  }

  async notFoundHandler(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    this.returnCannedResponse(res, {
      statusCode: 404,
    });
    return;
  }

  async errorHandler(
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> {
    if (err instanceof SyntaxError) {
      this.returnCannedResponse(res, {
        errorCode: ErrorCode.InvalidContentForContentType,
      });
      return;
    }
    this.returnCannedResponse(res, {
      statusCode: 500,
      message: err.message,
    });
    return;
  }

  setupRouter() {
    this.api.use(responseTime());
    this.api.use(cors());
    this.api.use(this.authenticationMiddleware.bind(this));
    this.api.use(bodyParser.text({ type: "text/*" }));
    this.api.use(bodyParser.json({ type: ContentTypes.json }));
    this.api.use(bodyParser.json({ type: ContentTypes.olrapiNoteJson }));
    this.api.use(bodyParser.json({ type: ContentTypes.jsonLogic }));
    this.api.use(bodyParser.raw({ type: "application/*" }));

    this.api
      .route("/vault/*")
      .get(this.vaultGet.bind(this))
      .put(this.vaultPut.bind(this))
      .patch(this.vaultPatch.bind(this))
      .post(this.vaultPost.bind(this))
      .delete(this.vaultDelete.bind(this));

    this.api
      .route("/periodic/:period/")
      .get(this.periodicGet.bind(this))
      .put(this.periodicPut.bind(this))
      .patch(this.periodicPatch.bind(this))
      .post(this.periodicPost.bind(this))
      .delete(this.periodicDelete.bind(this));

    this.api.route("/commands/").get(this.commandGet.bind(this));
    this.api.route("/commands/:commandId/").post(this.commandPost.bind(this));

    this.api.route("/search/").post(this.searchQueryPost.bind(this));
    this.api.route("/search/simple/").post(this.searchSimplePost.bind(this));
    this.api.route("/search/uid/").post(this.searchUidPost.bind(this));
    this.api.route("/search/gui/").post(this.searchGuiPost.bind(this));

    this.api.route("/open/*").post(this.openPost.bind(this));

    this.api.get(`/${CERT_NAME}`, this.certificateGet.bind(this));
    this.api.get("/", this.root.bind(this));

    this.api.use(this.notFoundHandler.bind(this));
    this.api.use(this.errorHandler.bind(this));
  }
}



