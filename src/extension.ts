'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { PlsqlDebugSession } from './plsqlDebug';

export function activate(context: vscode.ExtensionContext) {

	// register a configuration provider for 'plsql' debug type
	const provider = new PlsqlConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('plsql', provider));

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory = new InlineDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('plsql', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	vscode.languages.registerEvaluatableExpressionProvider('plsql', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position)
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	});
}

export function deactivate() {
	// nothing to do
	console.log('desactivate');
}

class PlsqlConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'plsql') {
				config.type = 'plsql';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.watchingSchemas = [''];
				config.socketPort = 4000;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new PlsqlDebugSession());
	}
}
