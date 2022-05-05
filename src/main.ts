import { App, Plugin, PluginSettingTab, Setting, Modal, addIcon, Notice } from "obsidian";
import * as https from "https";
import * as http from "http";
import forge, { pki } from "node-forge";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

import { CERT_NAME, DEFAULT_SETTINGS, HOSTNAME } from "./constants";

import fs from "fs";
//import supermemo18Icon from "./assets/supermemo18.svg"




export default class LocalRestApi extends Plugin {
  settings: LocalRestApiSettings;
  secureServer: https.Server | null = null;
  insecureServer: http.Server | null = null;
  requestHandler: RequestHandler;

  async onload() {
    await this.loadSettings();
    this.requestHandler = new RequestHandler(
      this.app,
      this.manifest,
      this.settings
    );
    this.requestHandler.setupRouter();
    let syncitem = this.addStatusBarItem();

    syncitem.createEl("span", { text: "⏳Sync..." });
    this.settings.StatusBarItemDisplay = "none";
    this.registerInterval(
      window.setInterval(() => this.updateStatusBar(syncitem), 1000)
    );

    //syncitem.style.display = this.settings.StatusBarItemDisplay;
    // addIcon('supermemo18Icon', 'svg viewBox="0 0 100 100"><path d="M15.654 37.218l21.998 -0.917c0.356' +
    //   '1.503 1.472 2.71 2.922 3.188l2.798 27.568 -28.033 -29.115c0.128 -0.228 0.234-0.471 0');
    this.addRibbonIcon('sync', 'Sync your markdown to supermemo18', async () => {
      console.log("开始同步");
      await this.manualSync();
    });

    this.app;

    this.addCommand({
      id: 'sync-yourmd-supermemo',
      name: '同步你的markdown到supermemo18',
      callback: async () => {
        new Notice("开始同步");
        await this.manualSync();
      }

    });
    if (this.settings.crypto && this.settings.crypto.resetOnNextLoad) {
      delete this.settings.apiKey;
      delete this.settings.crypto;
      this.saveSettings();
    }

    if (!this.settings.apiKey) {
      this.settings.apiKey = forge.md.sha256
        .create()
        .update(forge.random.getBytesSync(128))
        .digest()
        .toHex();
      this.saveSettings();
    }
    if (!this.settings.crypto) {
      const expiry = new Date();
      const today = new Date();
      expiry.setDate(today.getDate() + 365);

      const keypair = forge.pki.rsa.generateKeyPair(2048);
      const attrs = [{ name: "commonName", value: "Obsidian Local REST API" }];
      const certificate = forge.pki.createCertificate();
      certificate.setIssuer(attrs);
      certificate.setSubject(attrs);
      certificate.setExtensions([
        {
          name: "basicConstraints",
          cA: true,
        },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
          dataEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: true,
          codeSigning: true,
          emailProtection: true,
          timeStamping: true,
        },
        {
          name: "nsCertType",
          client: true,
          server: true,
          email: true,
          objsign: true,
          sslCA: true,
          emailCA: true,
          objCA: true,
        },
        {
          name: "subjectAltName",
          altNames: [
            {
              type: 7, // IP
              ip: HOSTNAME,
            },
          ],
        },
      ]);
      certificate.serialNumber = "1";
      certificate.publicKey = keypair.publicKey;
      certificate.validity.notAfter = expiry;
      certificate.validity.notBefore = today;
      certificate.sign(keypair.privateKey, forge.md.sha256.create());

      this.settings.crypto = {
        cert: pki.certificateToPem(certificate),
        privateKey: pki.privateKeyToPem(keypair.privateKey),
        publicKey: pki.publicKeyToPem(keypair.publicKey),
      };
      this.saveSettings();
    }

    this.addSettingTab(new LocalRestApiSettingTab(this.app, this));

    this.refreshServerState();
  }
  updateStatusBar(syncitem: HTMLElement) {
    syncitem.style.display = this.settings.StatusBarItemDisplay;
  }


  async manualSync() {

    let configTxt: string = fs.readFileSync(this.settings.qkIniPath, { encoding: 'utf8' });
    console.log(configTxt);

    const editedId = this.requestHandler.pad(configTxt.match(/editedEleId ?= ?(.+)/)[1], 8);//要查询的元素id 等于 editedEleID
    console.log(this.requestHandler.pad(configTxt.match(/editedEleId ?= ?(.+)/)[1], 8));
    const uidFieldName: string = configTxt.match(/mdUIDFieldName ?= ?(.+)/)[1];

    const field_domain: number = parseInt(configTxt.match(/field_domain ?= ?(.+)/)[1], 10);
    const toMdFolderPath: string = configTxt.match(/SM2OBFolderPath ?= ?(.+)/)[1];//SM2OBFolderPath
    //decodeURIComponent
    const SMQAdelimiter: string = configTxt.match(/SMQAdelimiter ?= ?(.+)/)[1];//QA 之间的分割符号
    const SMEleType: string = configTxt.match(/SMEleType ?= ?(.+)/)[1];//元素类型
    const SMEditProIsRunning: boolean = configTxt.match(/SMEditProIsRunning ?= ?(.+)/)[1] === 'true' ? true : false;
    let resUid: string = "";
    if (!SMEditProIsRunning) {
      //命令在quicker 动作 SMEditorPro 没有打开的情况下不能使用
      new Notice("Error,quicker SMEditorPro 动作没有执行，同步不能单独使用");
    } else if (!(SMEleType === 'Item')) {//当前要同步的元素不是item
      window.open("quicker:runaction:" + this.settings.double_chain_reference_actionId + "?manualSync");
      new Notice("warning!,当前元素为非item类型，因此仅仅同步内容到SM，并没有生成md");

    } else {

      try {
        if (this.requestHandler.lastSearchUidPath == undefined) {
          resUid = this.requestHandler.getFileFromUID(editedId, uidFieldName)?.path;
        } else {
          let md_txt = await this.app.vault.adapter.read(this.requestHandler.lastSearchUidPath);
          let yaml_txt = "";
          var extractIdRegexObj = new RegExp(uidFieldName + ": ?(.+)");
          let md_id = "";
          if (md_txt.match(/^(---)((.|\s)*?)(---)/) != null) {
            yaml_txt = md_txt.match(/^(---)((.|\s)*?)(---)/)[2];
            yaml_txt = yaml_txt.trim();
            md_id = yaml_txt.match(extractIdRegexObj)[1];
            if (editedId == md_id) {//匹配lastSearchUidPath 
              resUid = this.requestHandler.lastSearchUidPath;
            } else {//不匹配重新查询
              resUid = this.requestHandler.getFileFromUID(editedId, uidFieldName)?.path;

            }
          } else {
            new Notice("error!" + this.requestHandler.lastSearchUidPath + ": 此markdown中没有Uid字段")
          }
        }
      } catch (error) {
        this.requestHandler.lastSearchUidPath = undefined;
        new Notice("error! " + "this.lastSearchUidPath" + error)
      }


      if (resUid != undefined) {
        //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 有md路径
        let outputPath = resUid;
        await this.requestHandler.persistentMd(this.settings.O2SInputPath, outputPath, field_domain, SMQAdelimiter, false);
      } else {
        //根据uid 没有查询到文件
        //相当于原有（SMEditorProPlugin_OB2SM）的子程序更新md内容 没有md路径
        let prompt = new InputTitlePrompt(this.app, async (result) => {

          new Notice(`你输入的标题为, ${result}!`);
          await this.requestHandler.createPersistentMd(this.settings.O2SInputPath, field_domain, toMdFolderPath, SMQAdelimiter, query, uidFieldName, result, true, res);
          this.settings.StatusBarItemDisplay = "none";
        });

        let timeout = window.setTimeout(() => this.requestHandler.operationTimeOut(prompt, timeout, true, res), 15000)
        prompt.setTimeOutNum(timeout);
        prompt.open();

      }

    }

  }



  refreshServerState() {
    if (this.secureServer) {
      this.secureServer.close();
      this.secureServer = null;
    }
    this.secureServer = https.createServer(
      { key: this.settings.crypto.privateKey, cert: this.settings.crypto.cert },
      this.requestHandler.api
    );
    this.secureServer.listen(this.settings.port, HOSTNAME);

    console.log(
      `REST API listening on https://${HOSTNAME}/${this.settings.port}`
    );

    if (this.insecureServer) {
      this.insecureServer.close();
      this.insecureServer = null;
    }
    if (this.settings.enableInsecureServer) {
      this.insecureServer = http.createServer(this.requestHandler.api);
      this.insecureServer.listen(this.settings.insecurePort, HOSTNAME);

      console.log(
        `REST API listening on http://${HOSTNAME}/${this.settings.insecurePort}`
      );
    }
  }

  onunload() {
    if (this.secureServer) {
      this.secureServer.close();
    }
    if (this.insecureServer) {
      this.insecureServer.close();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LocalRestApiSettingTab extends PluginSettingTab {
  plugin: LocalRestApi;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.classList.add("obsidian-local-rest-api-settings");

    const apiKeyDiv = containerEl.createEl("div");
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("h3", { text: "Your API Key" });
    apiKeyDiv.createEl("p", {
      text: "This must be passed in all requests via an authorization header.",
    });
    apiKeyDiv.createEl("pre", { text: this.plugin.settings.apiKey });
    apiKeyDiv.createEl("p", { text: "Example header: " });
    apiKeyDiv.createEl("pre", {
      text: `Authorization: Bearer ${this.plugin.settings.apiKey}`,
    });

    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      text: "See more information and examples in our interactive OpenAPI documentation.",
    });

    const importCert = apiKeyDiv.createEl("p");
    importCert.createEl("span", {
      text: "By default this plugin uses a self-signed certificate for HTTPS; you may want to ",
    });
    importCert.createEl("a", {
      href: `https://127.0.0.1:${this.plugin.settings.port}/${CERT_NAME}`,
      text: "download this certificate",
    });
    importCert.createEl("span", {
      text: " to use it for validating your connection's security by adding it as a trusted certificate authority in the browser or tool you are using for interacting with this API.",
    });

    new Setting(containerEl)
      .setName("Secure HTTPS Server Port")
      .setDesc(
        "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  In no circumstance is it recommended that you expose this service directly to the internet."
      )
      .addText((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.port = parseInt(value, 10);
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.port.toString())
      );

    new Setting(containerEl)
      .setName("Enable Insecure HTTP Server")
      .setDesc(
        "Enables an insecure HTTP server on the port designated below.  By default, this plugin requires a secure HTTPS connection, but in secure environments you may turn on the insecure server to simplify interacting with the API. Interactions with the API will still require the API Key shown above.  In no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!"
      )
      .addToggle((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.enableInsecureServer = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.enableInsecureServer)
      );

    new Setting(containerEl)
      .setName("Insecure HTTP Server Port")
      .addText((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.insecurePort = parseInt(value, 10);
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.insecurePort.toString())
      );

    containerEl.createEl("hr");
    containerEl.createEl("h3", {
      text: "HTTPs Certificate Settings",
    });
    containerEl.createEl("p", {
      text: `The following are your Local REST API's public key, certificate, and private key.  These are automatically generated the first time this plugin is loaded, but you can update them to use keys you have generated if you would like to do so.`,
    });

    new Setting(containerEl)
      .setName("Reset Crypto on next Load")
      .setDesc(
        "Turning this toggle 'on' will cause your certificates and api key to be regenerated when this plugin is next loaded.  You can force a reload by running the 'Reload app without saving' command from the command palette, closing and re-opening Obsidian, or turning this plugin off and on again from the community plugins panel in Obsidian's settings."
      )
      .addToggle((value) => {
        value
          .onChange((value) => {
            this.plugin.settings.crypto.resetOnNextLoad = value;
            this.plugin.saveSettings();
          })
          .setValue(this.plugin.settings.crypto.resetOnNextLoad);
      });
    new Setting(containerEl).setName("Certificate").addTextArea((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.crypto.cert = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        })
        .setValue(this.plugin.settings.crypto.cert)
    );
    new Setting(containerEl).setName("Public Key").addTextArea((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.crypto.publicKey = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        })
        .setValue(this.plugin.settings.crypto.publicKey)
    );
    new Setting(containerEl).setName("Private Key").addTextArea((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.crypto.privateKey = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        })
        .setValue(this.plugin.settings.crypto.privateKey)
    );

    containerEl.createEl("hr");
    containerEl.createEl("h3", {
      text: "SMEditor相关设置",
    });

    new Setting(containerEl)
      .setName("SMEditorPro action config path")
      .addTextArea(cb => cb.onChange(value => {
        this.plugin.settings.qkIniPath = value;
        this.plugin.saveSettings();
      }).setValue(this.plugin.settings.qkIniPath));

    new Setting(containerEl).setName("workpace md(temp md) path").addTextArea((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.O2SInputPath = value;
          this.plugin.saveSettings();
        })
        .setValue(this.plugin.settings.O2SInputPath)
    );
    new Setting(containerEl).setName("SMEditorPro双链引用保存动作id").addTextArea((cb) =>
      cb
        .onChange((value) => {
          this.plugin.settings.double_chain_reference_actionId = value;
          this.plugin.saveSettings();
        })
        .setValue(this.plugin.settings.double_chain_reference_actionId)
    );


  }
}


export class InputTitlePrompt extends Modal {
  result: string;
  onSubmit: (result: string) => void;
  timeoutnumber: number;
  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;

  }
  setTimeOutNum(num: number) {
    this.timeoutnumber = num;

  }
  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "markdown标题" });

    new Setting(contentEl)
      .setName("Title")
      .addText((text) =>
        text.onChange((value) => {
          this.result = value
        }));

    //let operatimeout = window.setTimeout(() => this.opertiontimeout(), 10000);
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Submit")
          .setCta()
          .onClick(() => {
            this.close();
            this.onSubmit(this.result);
            //window.clearTimeout(operatimeout);
            window.clearTimeout(this.timeoutnumber);
          }));






  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();

  }

  opertiontimeout() {
    this.close()
    console.log("超时后的操作")
  }
}

