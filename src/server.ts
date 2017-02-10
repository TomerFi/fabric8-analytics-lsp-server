/* --------------------------------------------------------------------------------------------
 * Copyright (c) Pavel Odvody 2016
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import * as path from 'path';
import * as fs from 'fs';
import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, CodeLens, CodeLensRequest, CodeLensParams
} from 'vscode-languageserver';
import { stream_from_string, get_range } from './utils';
import { DependencyCollector, IDependencyCollector, IDependency } from './collector';
import { EmptyResultEngine, CryptoEngine, LicenseEngine, SecurityEngine, DiagnosticsPipeline } from './consumers';

const url = require('url');
const http = require('http');
const request = require('request');

/*
let log_file = fs.openSync('file_log.log', 'w');
let _LOG = (data) => {
    fs.writeFileSync('file_log.log', data + '\n');
}
*/

enum EventStream {
  Invalid,
  Diagnostics,
  CodeLens
};

let connection: IConnection = null;
/* use stdio for transfer if applicable */
if (process.argv.indexOf('--stdio') == -1)
    connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
else
    connection = createConnection()

let documents: TextDocuments = new TextDocuments();
documents.listen(connection);

let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            textDocumentSync: documents.syncKind
        }
    }
});

interface IFileHandlerCallback {
    (uri: string, name: string, contents: string): void;
};

interface IAnalysisFileHandler {
    matcher:  RegExp;
    stream: EventStream;
    callback: IFileHandlerCallback;
};

interface IAnalysisFiles {
    handlers: Array<IAnalysisFileHandler>;
    file_data: Map<string, string>;
    on(stream: EventStream, matcher: string, cb: IFileHandlerCallback): IAnalysisFiles;
    run(stream: EventStream, uri: string, file: string, contents: string): any;
};

class AnalysisFileHandler implements IAnalysisFileHandler {
    matcher: RegExp;
    constructor(matcher: string, public stream: EventStream, public callback: IFileHandlerCallback) {
        this.matcher = new RegExp(matcher);
    }
};

class AnalysisFiles implements IAnalysisFiles {
    handlers: Array<IAnalysisFileHandler>;
    file_data: Map<string, string>;
    constructor() {
        this.handlers = [];
        this.file_data = new Map<string, string>();
    }
    on(stream: EventStream, matcher: string, cb: IFileHandlerCallback): IAnalysisFiles {
        this.handlers.push(new AnalysisFileHandler(matcher, stream, cb));
        return this;
    }
    run(stream: EventStream, uri: string, file: string, contents: string): any {
        for (let handler of this.handlers) {
            if (handler.stream == stream && handler.matcher.test(file)) {
                return handler.callback(uri, file, contents);
            }
        }
    }
};

interface IAnalysisLSPServer
{
    connection: IConnection;
    files:      IAnalysisFiles;

    handle_file_event(uri: string, contents: string): void;
    handle_code_lens_event(uri: string): CodeLens[];
};

class AnalysisLSPServer implements IAnalysisLSPServer {
    constructor(public connection: IConnection, public files: IAnalysisFiles) {}

    handle_file_event(uri: string, contents: string): void {
        let path_name = url.parse(uri).pathname;
        let file_name = path.basename(path_name);

        this.files.file_data[uri] = contents;

        this.files.run(EventStream.Diagnostics, uri, file_name, contents);
    }

    handle_code_lens_event(uri: string): CodeLens[] {
        let path_name = url.parse(uri).pathname;
        let file_name = path.basename(path_name);
        let lenses = [];
        let contents = this.files.file_data[uri];
        return this.files.run(EventStream.CodeLens, uri, file_name, contents);
    }
};

interface IAggregator
{
    callback: any;
    is_ready(): boolean;
    aggregate(IDependency): void;
};

class Aggregator implements IAggregator
{
    mapping: Map<IDependency, boolean>;
    diagnostics: Array<Diagnostic>;
    constructor(items: Array<IDependency>, public callback: any){
        this.mapping = new Map<IDependency, boolean>();
        for (let item of items) {
            this.mapping.set(item, false);
        }
    }
    is_ready(): boolean {
        let val = true;
        for (let m of this.mapping.entries()) {
            val = val && m[1];
        }
        return val;
    }
    aggregate(dep: IDependency): void {
        this.mapping.set(dep, true);
        if (this.is_ready()) {
            this.callback();
        }
    }
};

class AnalysisConfig 
{
    server_url:         string;
    forbidden_licenses: Array<string>;
    no_crypto:          boolean;
    home_dir:           string;

    constructor() {
        this.server_url = 'http://ose-vm1.lab.eng.blr.redhat.com:32000/api/v1';
        this.forbidden_licenses = [];
        this.no_crypto = false;
        this.home_dir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
    }
};

let config: AnalysisConfig = new AnalysisConfig();
let files: IAnalysisFiles = new AnalysisFiles();
let server: IAnalysisLSPServer = new AnalysisLSPServer(connection, files);
let stack_analysis_requests: Map<String, String> = new Map<String, String>();
let stack_analysis_responses: Map<String, String> = new Map<String, String>();

let rc_file = path.join(config.home_dir, '.analysis_rc');
if (fs.existsSync(rc_file)) {
    let rc = JSON.parse(fs.readFileSync(rc_file, 'utf8'));
    if ('server' in rc) {
        config.server_url = `${rc.server}/api/v1`;
    }
    if ('forbidden_licenses' in rc) {
        config.forbidden_licenses = config.forbidden_licenses.concat(rc.forbidden_licenses);
    }
    if ('no_crypto' in rc) {
        config.no_crypto = rc.no_crypto;
    }
}

let DiagnosticsEngines = [LicenseEngine, SecurityEngine, EmptyResultEngine];
if (config.no_crypto) {
    DiagnosticsEngines.push(CryptoEngine);
}

let stack_collector = (file_uri: String, id: String) => {
    let query = `${config.server_url}/stack-analyses/${id}`;

    request.get(query, (err, httpResponse, body) => {
        let data = JSON.parse(body);
        if (data.status == 'success') {
            stack_analysis_responses.set(file_uri, data);
        } else {
            // TODO: Give Stack Analysis API a little bit more sanity
            // right now it returns (202, '{"error": ...}') when Analysis
            // is in progress 
            if (httpResponse.statusCode == 202) {
                setTimeout(() => { stack_collector(file_uri, id) }, 10000)
            }
        }
    });
}

let get_stack_metadata = (file_uri, context) => {
    /* request had already been sent */
    if (file_uri in stack_analysis_requests) {
        return;
    }

    let query = `${config.server_url}/stack-analyses/`;

    let form_data = {
        'manifest[]': [{
            value: context.manifest, 
            options: {
                filename: 'package.json', 
                contentType: 'application/json'
            }
        }],
        origin: context.origin || 'lsp'
    };

    request.post({url: query, formData: form_data}, (err, httpResponse, body) => {
        if (!err) {
            let resp = JSON.parse(body);
            if (resp.error === undefined && resp.status == 'success') {
                stack_analysis_requests[file_uri] = resp.id;
                setTimeout(() => { stack_collector(file_uri, resp.id) }, 10000);
            }
        } else {
            // abort, retry, ignore, fail?
            //_LOG(`err: ${err}`)
        }
    });
};

let get_metadata = (ecosystem, name, version, cb) => {
    let part = [ecosystem, name, version].join('/');
    let query = `${config.server_url}/analyses/${part}/`;

    http.get(query, function(res){
        let body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function(){
            if (this.statusCode == 200 || this.statusCode == 202) {
                let response = JSON.parse(body);
                cb(response);
            } else {
                cb(null);
            }
        });
    });
};

files.on(EventStream.Diagnostics, "^package\\.json$", (uri, name, contents) => {
    /* Convert from readable stream into string */
    let stream = stream_from_string(contents);
    let collector = new DependencyCollector();
    /* Go through all the dependencies */
    get_stack_metadata(uri, {manifest: contents});

    collector.collect(stream).then((deps) => {
        let diagnostics = [];
        /* Aggregate asynchronous requests and send the diagnostics at once */
        let aggregator = new Aggregator(deps, () => {
            connection.sendDiagnostics({uri: uri, diagnostics: diagnostics});
        });
        for (let dependency of deps) {
            get_metadata('npm', dependency.name.value, dependency.version.value, (response) => {
                if (response != null) {
                    let pipeline = new DiagnosticsPipeline(DiagnosticsEngines, dependency, config, diagnostics);
                    pipeline.run(response);
                }
                aggregator.aggregate(dependency);
            });
        }
    });
});

connection.onDidSaveTextDocument((params) => {
    server.handle_file_event(params.textDocument.uri, server.files.file_data[params.textDocument.uri]);
});

connection.onDidChangeTextDocument((params) => {
    /* Update internal state for code lenses */
    server.files.file_data[params.textDocument.uri] = params.contentChanges[0].text;
});

connection.onDidOpenTextDocument((params) => {
    server.handle_file_event(params.textDocument.uri, params.textDocument.text);
});

connection.listen();
