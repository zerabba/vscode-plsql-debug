import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Handles } from 'vscode-debugadapter';
const { listen } = require('./lib/jdwp/listen');

export interface PlsqlBreakpoint {
	id: number;
	line: number;
	verified: boolean;
	eventRequest;
}

export enum StepType {
	INTO = 1,
	OVER,
	OUT,
}

export interface PlsqlClazzFilePath {
	aFilePath: string,
	aBodyLine: number
}

/**
 * A Plsql runtime with minimal debugger functionality.
 */
export class PlsqlRuntime extends EventEmitter {

	// the virtual machine
	private _vm;
	private _currentThread;
	private _currentFrame;
	private _currentMethod;

	private _builtinValues = ['L$Oracle/Builtin/VARCHAR2;', 'L$Oracle/Builtin/NVARCHAR2;', 'L$Oracle/Builtin/NUMBER;', 'L$Oracle/Builtin/FLOAT;',
		'L$Oracle/Builtin/LONG;', 'L$Oracle/Builtin/DATE;', 'L$Oracle/Builtin/BINARY_FLOAT;', 'L$Oracle/Builtin/BINARY_DOUBLE;',
		'L$Oracle/Builtin/TIMESTAMP;', 'L$Oracle/Builtin/TIMESTAMP_WITH_TIMEZONE;', 'L$Oracle/Builtin/TIMESTAMP_WITH_LOCAL_TIMEZONE;',
		'L$Oracle/Builtin/RAW;', 'L$Oracle/Builtin/UROWID;', 'L$Oracle/Builtin/CHAR;', 'L$Oracle/Builtin/NCHAR;',
		'L$Oracle/Builtin/CLOB;', 'L$Oracle/Builtin/NCLOB;', 'L$Oracle/Builtin/BOOLEAN;',
		'L$Oracle/Builtin/PLS_INTEGER;', 'L$Oracle/Builtin/BINARY_INTEGER;']

	private _regexBody = /create or replace (function|procedure|trigger|package body) (?<schema>[^\.]*\.){0,1}(?<package>[^\n|\()]*)/gi;

	// the current source file path
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	// the contents (= lines) of the current source file
	private _sourceLines: string[];

	// maps from sourceFile to array of Plsql breakpoints
	private _breakPoints = new Map<string, PlsqlBreakpoint[]>();
	// maps from sourceFile to oracle class
	private _plsqlClazzFilePath = new Map<string, PlsqlClazzFilePath>();
	// maps the unloadded clazzes
	private _unloaddedClazzes = new Map<string, string>();
	// list of schema that we want to put some breakpoints
	private _arrSchemas = new Set<string>();

	// list of handles on variables
	private _variableHandles = new Handles<string>();
	// list of all variable of type object
	private _plsqlObjectValue = new Map<string, any>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, watchingSchemas: string[], socketPort: number) {
		this.sendEvent('output', 'Debug started on port ' + socketPort + ', waiting on the client to connect...');
		await new Promise(resolve => setTimeout(resolve, 1000));
		this._vm = await listen(socketPort);

		for (let schema of watchingSchemas) {
			this._arrSchemas.add(schema.toUpperCase());
			this.sendEvent('output', 'Adding watching schema ' + schema);
		}

		this._vm.on('event', async ({ events }) => {
			for (const event of events) {
				if (event.eventKind === 'VM_DEATH') {
					this.sendEvent('output', 'Debug ended...')
					this.sendEvent('end');
					/*} else if(event.eventKind === 'CLASS_PREPARE') {
						console.log('CLASS_PREPARE: '+event.signature);*/
				} else if (event.eventKind === 'CLASS_UNLOAD') {
					const signature = this.getSignature(event.signature);
					const plsqlClazzFilePath = this._plsqlClazzFilePath.get(signature);
					if (plsqlClazzFilePath) {
						await this._vm.suspend();
						let bps = this._breakPoints.get(plsqlClazzFilePath.aFilePath);
						if (bps) {
							for (let bp of bps) {
								bp.verified = false;
							}
						}
						if (!this._unloaddedClazzes.get(signature)) {

							this.addClassPrepareRequest(signature, plsqlClazzFilePath.aFilePath, plsqlClazzFilePath.aBodyLine);
							if (signature.indexOf('$Oracle/PackageBody') > -1) {
								this.addClassPrepareRequest(signature.replace('$Oracle/PackageBody', '$Oracle/Package'), plsqlClazzFilePath.aFilePath, plsqlClazzFilePath.aBodyLine);
							}
						}
						await this._vm.resume();
					}
				} else if (['BREAKPOINT', 'SINGLE_STEP'].indexOf(event.eventKind) > -1) {

					try {
						this._currentThread = this._vm.thread(event.thread);
						const frames = await this._currentThread.frames();
						this._currentFrame = frames[0];

						if (this._currentFrame.location.declaringType.signature) {
							const clazz = (await this._vm.retrieveClassesBySignature(this.getSignature(this._currentFrame.location.declaringType.signature)))[0];
							const className = await clazz.getName();
							this._currentMethod = await this._currentFrame.location.getMethod();

							const plsqlClazzFilePath = this._plsqlClazzFilePath.get(clazz.signature);
							const fileChanged = plsqlClazzFilePath && this._sourceFile !== plsqlClazzFilePath.aFilePath;
							if (plsqlClazzFilePath && fileChanged) {
								await this.loadSource(plsqlClazzFilePath.aFilePath);
							} else if (!plsqlClazzFilePath) {

								// ask the user where the source file could be...
								// should find a better solution, maybe connect to the DB?
								await vscode.commands.executeCommand(
									'workbench.action.quickOpen',
									className.substring(className.lastIndexOf('.') + 1)
								);
								await new Promise(resolve => setTimeout(resolve, 1000));
								if (vscode.window.activeTextEditor) {
									vscode.window.showTextDocument(vscode.window.activeTextEditor.document);
									await this.loadSource(vscode.window.activeTextEditor.document.uri.fsPath);
								}
							}

							if (event.eventKind === 'SINGLE_STEP') {
								this.sendEvent('stopOnEntry');
							} else {
								this.sendEvent('stopOnBreakpoint');
							}
						} else {
							this.step(StepType.OVER);
						}
					} catch (err) {
						console.log(err);
						this.step(StepType.OVER);
					}
				}
			}
		});
		await this._vm.ready();

		await this.verifyBreakpoints('', false);

		await this.loadSource(program);

		// we just start to run until we hit a breakpoint or an exception
		this.continue();
	}

	public async stop() {
		await this._vm.dispose();
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue(reverse = false) {
		await this._vm.resume();
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public async step(stepType: StepType) {
		const er = this._vm.eventRequestManager.createStepRequest(this._currentThread, -2, stepType);
		er.suspendPolicy = 1;
		er.addCountFilter(1);
		await er.enable();

		const suspends = await this._currentThread.suspendCount();
		for (let i = 0; i < suspends; i++) {
			await this._currentThread.resume();
		}
	}

	private getSignature(signature) {
		let strSignature = signature;
		while (strSignature instanceof Object) {
			strSignature = strSignature.signature;
		}
		return strSignature;
	}

	public async stack(maxLevels: number): Promise<any> {
		let cpt = 0;
		const frames = new Array<any>();

		try {
			const vmFrames = await this._currentThread.frames();

			for (const frame of vmFrames) {
				try {
					if (frame.location.declaringType && this.getSignature(frame.location.declaringType.signature)) {
						const clazz = (await this._vm.retrieveClassesBySignature(this.getSignature(frame.location.declaringType.signature)))[0];
						if (clazz) {
							let className = (await clazz.getName())
							if (className) {
								className = className.replace(/[^\.]+\.[^\.]+\./g, '');
							}
							const method = await frame.location.getMethod();
							const { lineLocations } = await method.getBaseLocations();
							let line;
							for (const location of lineLocations) {
								if (location.codeIndex <= frame.location.codeIndex) {
									line = location.baseLineInfo;
								}
							}
							const plsqlClazzFilePath = this._plsqlClazzFilePath.get(clazz.signature)
							if (plsqlClazzFilePath) {
								let currentLine = line.lineNumber + plsqlClazzFilePath.aBodyLine - 1;
								frames.push({
									index: cpt++,
									name: `${className}.${method.name}()`,
									file: plsqlClazzFilePath.aFilePath,
									line: currentLine
								});
							}
							if (cpt > maxLevels) {
								break;
							}
						}
					}
				} catch (err) {
					console.log(err);
				}
			}
		} catch (err) {
			console.log(err);
		}

		return {
			frames: frames,
			count: frames.length
		};
	}

	private async getBuiltinValue(name, signature: string, fieldValue): Promise<DebugProtocol.Variable> {
		let result;
		try {
			if (this._builtinValues.indexOf(signature) > -1) {
				const BuiltinClazz = (await this._vm.retrieveClassesBySignature(signature))[0];
				const BuiltinFldVal = await BuiltinClazz.fieldByName('_value');
				const fieldValueObj = this._vm.objectMirror(fieldValue.value, fieldValue.tag);
				let _value = await fieldValueObj.getValue(BuiltinFldVal);
				const _valueObj = this._vm.objectMirror(_value.value, _value.tag);
				let valueContent = '';
				if (_valueObj) {
					valueContent = await _valueObj.getValue();
				}
				result = {
					name: name,
					type: signature.slice(signature.lastIndexOf('/') + 1, -1),
					value: valueContent,
					variablesReference: 0
				}

			} else if (signature.endsWith('/Rowtype;')) {
				this._plsqlObjectValue.set(signature, fieldValue);
				result = {
					name: name,
					type: "object",
					value: "Object",
					variablesReference: this.getNewVariableHandles(signature)
				}
			} else if (!signature.startsWith('Ljava/')) {
				this.sendEvent('output', 'Signature not yet implemented:' + signature);
				console.error('Signature not yet implemented:' + signature);
				const BuiltinClazz = (await this._vm.retrieveClassesBySignature(signature))[0];
				let fields = await BuiltinClazz.visibleFields();
				console.log('fields', fields);
			}
		} catch (err) {
			result = {
				name: name,
				type: "string",
				value: '',
				variablesReference: 0
			}
		}
		return result;
	}

	private async setBuiltinValue(value, signature: string, fieldValue) {
		try {
			if (this._builtinValues.indexOf(signature) > -1) {
				const BuiltinClazz = (await this._vm.retrieveClassesBySignature(signature))[0];
				const BuiltinFldVal = await BuiltinClazz.fieldByName('_value');
				const fieldValueObj = this._vm.objectMirror(fieldValue.value, fieldValue.tag);
				let newStr = await this._vm.createString(value);
				await fieldValueObj.setValue(BuiltinFldVal, {
					tag: 115,
					value: newStr.ref
				});
			}
		} catch (err) {
			console.log(err);
			this.sendEvent('output', 'Unable to update variable with value ' + value);
		}
	}

	private async setVariable(name, newValue): Promise<any> {
		let vmVariables = await this._currentMethod.getVariables();
		for (const vmVariable in vmVariables) {
			if (vmVariables[vmVariable].name === name) {
				const fieldValue = await this._currentFrame.getValue(vmVariables[vmVariable]);
				await this.setBuiltinValue(newValue, vmVariables[vmVariable].signature, fieldValue);
				return (await this.getBuiltinValue(vmVariables[vmVariable].name, vmVariables[vmVariable].signature, fieldValue)).value;
			}
		}
	}

	private async setGlobaleVariable(fromHeader, name, newValue): Promise<any> {
		let signature = this._currentFrame.location.declaringType.signature;
		if (fromHeader) {
			signature = signature.replace('$Oracle/PackageBody/', '$Oracle/Package/')
		}
		const clazz = (await this._vm.retrieveClassesBySignature(signature))[0];
		const fields = await clazz.visibleFields();

		for (let cpt = 0; cpt < fields.length; cpt++) {
			if (fields[cpt].name === name) {
				// BUG: clazz.getValues() -> only the 1st record seems to have a value
				// --> that's why the slice(cpt, cpt+1)
				const fieldsValues = await clazz.getValues(fields.slice(cpt, cpt + 1));
				const fieldValue = fieldsValues[0];
				await this.setBuiltinValue(newValue, fields[cpt].signature, fieldValue);
				return (await this.getBuiltinValue(fields[cpt].name, fields[cpt].signature, fieldValue)).value;
			}
		}
	}

	private async setObjectVariable(signature, name, newValue): Promise<any> {
		const fieldValue = this._plsqlObjectValue.get(signature);
		const fieldValueObj = this._vm.objectMirror(fieldValue.value, fieldValue.tag);
		const clazz = (await this._vm.retrieveClassesBySignature(signature))[0];
		const fields = await clazz.visibleFields();
		for (let cpt = 0; cpt < fields.length; cpt++) {
			if (fields[cpt].name === name) {
				const fieldValue = await fieldValueObj.getValue(fields[cpt]);
				await this.setBuiltinValue(newValue, fields[cpt].signature, fieldValue);
				return (await this.getBuiltinValue(fields[cpt].name, fields[cpt].signature, fieldValue)).value;
			}
		}
	}

	public async setVariableRequest(name, newValue, variablesReference): Promise<any> {
		const id = this._variableHandles.get(variablesReference);
		if (id === 'local') {
			return await this.setVariable(name, newValue);
		} else if (id === 'globalHeader') {
			return await this.setGlobaleVariable(true, name, newValue);
		} else if (id === 'globalBody') {
			return await this.setGlobaleVariable(false, name, newValue);
		} else {
			return await this.setObjectVariable(id, name, newValue);
		}
	}

	public currentStepInPackage(): Promise<boolean> {
		return this._currentFrame.location.declaringType.signature.startsWith('L$Oracle/Package');
	}

	public async evaluateRequest(value: string): Promise<any> {
		let values = value.toUpperCase().split('.');
		let arrVariables = (await this.getVariables());
		if (this.currentStepInPackage()) {
			arrVariables.concat(await this.getGlobaleVariables(true));
			arrVariables.concat(await this.getGlobaleVariables(false));
		}
		if (values.length < 2) {
			for (let variable of arrVariables) {
				if (variable.name === values[0]) {
					return variable;
				}

			}
		} else {

			for (let i = 0; i < values.length; i++) {
				let currVal = values[i];
				for (let variable of arrVariables) {
					if (variable.name === currVal) {
						if (variable.type === 'object') {
							arrVariables = await this.getObjectVariables(this._variableHandles.get(variable.variablesReference));
							break;
						} else {
							return variable
						}
					}
				}
			}
		}
	}

	public getNewVariableHandles(name) {
		return this._variableHandles.create(name);
	}

	public async getVariableRequest(variablesReference) {
		const id = this._variableHandles.get(variablesReference);
		if (id === 'local') {
			return await this.getVariables();
		} else if (id === 'globalHeader') {
			return await this.getGlobaleVariables(true);
		} else if (id === 'globalBody') {
			return await this.getGlobaleVariables(false);
		} else {
			return await this.getObjectVariables(id);
		}
	}

	private async getVariables(): Promise<DebugProtocol.Variable[]> {
		const variables: DebugProtocol.Variable[] = [];
		let vmVariables = await this._currentMethod.getVariables();
		for (const vmVariable in vmVariables) {
			const fieldValue = await this._currentFrame.getValue(vmVariables[vmVariable]);
			variables.push(await this.getBuiltinValue(vmVariables[vmVariable].name, vmVariables[vmVariable].signature, fieldValue));
		}
		return variables;
	}

	private async getGlobaleVariables(fromHeader: Boolean): Promise<DebugProtocol.Variable[]> {
		const variables: DebugProtocol.Variable[] = [];
		let signature = this._currentFrame.location.declaringType.signature;
		if (fromHeader) {
			signature = signature.replace('$Oracle/PackageBody/', '$Oracle/Package/')
		}
		const clazz = (await this._vm.retrieveClassesBySignature(signature))[0];
		const fields = await clazz.visibleFields();

		for (let cpt = 0; cpt < fields.length; cpt++) {
			// BUG: clazz.getValues() -> only the 1st record seems to have a value
			// --> that's why the slice(cpt, cpt+1)
			const fieldsValues = await clazz.getValues(fields.slice(cpt, cpt + 1));
			const fieldValue = fieldsValues[0];
			variables.push(await this.getBuiltinValue(fields[cpt].name, fields[cpt].signature, fieldValue));
		}
		return variables;
	}

	private async getObjectVariables(signature: string): Promise<DebugProtocol.Variable[]> {
		const variables: DebugProtocol.Variable[] = [];
		const fieldValue = this._plsqlObjectValue.get(signature);
		const fieldValueObj = this._vm.objectMirror(fieldValue.value, fieldValue.tag);
		const clazz = (await this._vm.retrieveClassesBySignature(signature))[0];
		const fields = await clazz.visibleFields();
		for (let cpt = 0; cpt < fields.length; cpt++) {
			const fieldValue = await fieldValueObj.getValue(fields[cpt]);
			variables.push(await this.getBuiltinValue(fields[cpt].name, fields[cpt].signature, fieldValue));
		}
		return variables;
	}

	public async getBreakpoints(path: string): Promise<number[]> { //: number[]

		const bps: number[] = [];
		await this.loadSource(path)

		for (const [signature, clazzFilePath] of this._plsqlClazzFilePath) {
			if (clazzFilePath.aFilePath === path) {
				const clazzes = await this._vm.retrieveClassesBySignature(signature);
				for (const clazz of clazzes) {
					const locations = await clazz.allLineLocations();
					for (const location in locations) {
						bps.push(Number(location) + 1 + clazzFilePath.aBodyLine);
					}
				}
			}
		}
		return bps;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number): PlsqlBreakpoint {

		const bp = <PlsqlBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<PlsqlBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path, false);

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): PlsqlBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				bp.eventRequest.delete();
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public async clearBreakpoints(path: string): Promise<void> {
		let bps = this._breakPoints.get(path);
		if (bps && this._vm) {
			for (const bp of bps) {
				if (bp.verified) {
					await bp.eventRequest.delete();
				}
			}
		}
		this._breakPoints.delete(path);
	}

	private async loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			let clazzesFound = false;
			this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');

			// find package body statement
			for (let ln = 0; ln < this._sourceLines.length; ln++) {
				let match = this._regexBody.exec(this._sourceLines[ln]);
				if (match) {
					const forcedSchema = match[2];
					let currentClazzName = '';
					if (forcedSchema) {
						currentClazzName = forcedSchema;
					}
					currentClazzName += match[3];
					if (currentClazzName.length > 0) {
						currentClazzName = currentClazzName.toUpperCase().replace(/\s/, '');
						let oracleType = match[1].replace(' ', '').toLowerCase();
						oracleType = (oracleType.charAt(0).toUpperCase() + oracleType.slice(1)).replace('body', '');

						for (let schema of this._arrSchemas) {
							if (!forcedSchema || forcedSchema.toUpperCase().substring(0, forcedSchema.length - 1) === schema) {
								let signature = 'L$Oracle/' + oracleType + '/';
								if (forcedSchema) {
									signature += currentClazzName.replace(/\./g, '/') + ';';
								} else {
									signature += schema + '/' + currentClazzName + ';';
								}
								const clazzes = await this._vm.retrieveClassesBySignature(signature);
								for (const clazz of clazzes) {
									this._plsqlClazzFilePath.set(clazz.signature.replace('$Oracle/Package', '$Oracle/PackageBody'), { aFilePath: file, aBodyLine: ln });
									clazzesFound = true;
								}
								if (!this._unloaddedClazzes.get(signature)) {
									this.addClassPrepareRequest(signature, file, ln);
									if (oracleType === 'Package') {
										this.addClassPrepareRequest(signature.replace('$Oracle/Package', '$Oracle/PackageBody'), file, ln);
									}

								}
							}
						}
					}
				}
			}
			if (clazzesFound) {
				this.sendEvent('loaddedSource', file)
			}
		}
	}

	private async addClassPrepareRequest(signature, file, line) {
		const clazzName = signature.replace(/\//g, '.').slice(1, -1);
		const er = this._vm.eventRequestManager.createClassPrepareRequest();
		er.suspendPolicy = 2;
		er.addClassFilter(clazzName);
		er.addCountFilter(1);

		this._unloaddedClazzes.set(signature, file + ':' + line);

		er.on('event', async (event) => {
			const signature = this.getSignature(event.signature);
			const path = this._unloaddedClazzes.get(signature);
			if (path) {
				const file = path.substring(0, path.lastIndexOf(':'));
				const line = Number(path.substring(path.lastIndexOf(':') + 1));
				this._plsqlClazzFilePath.set(signature.replace('$Oracle/Package', '$Oracle/PackageBody'), { aFilePath: file, aBodyLine: line });
				await this.verifyBreakpoints(file, true);
				this._unloaddedClazzes.delete(signature);
				this.sendEvent('loaddedSource', file);
			}
			await this._vm.resume();
		});

		await er.enable();
	}

	private filePathLoaded(filePath: string): Boolean {
		for (const val of this._plsqlClazzFilePath.values()) {
			if (val.aFilePath == filePath) {
				return true;
			}
		}
		return false;
	}

	private async verifyBreakpoints(filterPath: string, fromClassLoad: boolean) {
		for (let [path, bps] of this._breakPoints) {
			if ((filterPath === '' || filterPath === path) && this._vm) {
				if (!fromClassLoad) {
					await this.loadSource(path);
				}
				for (const bp of bps) {

					if (!bp.verified && this.filePathLoaded(path)) {
						for (const [signature, clazzFilePath] of this._plsqlClazzFilePath) {
							const bodyLine = bp.line + 1 - clazzFilePath.aBodyLine;
							if (clazzFilePath.aFilePath === path) {
								const clazzes = await this._vm.retrieveClassesBySignature(signature);
								try {
									for (const clazz of clazzes) {
										const locations = await clazz.locationsOfLine(bodyLine);
										if (locations.length) {
											bp.eventRequest = this._vm.eventRequestManager.createBreakpointRequest(locations[0]);
											bp.eventRequest.suspendPolicy = 1;
											await bp.eventRequest.enable();

											bp.verified = true;
											this.sendEvent('breakpointValidated', bp);
										}
									}
								} catch (err) {
									this.sendEvent('output', 'not able to validate breakpoint', path, bodyLine);
								}
							}
						}
					}
				}
			}
		}
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}