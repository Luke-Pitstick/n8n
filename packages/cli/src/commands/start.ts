/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Container } from 'typedi';
import { Flags, type Config } from '@oclif/core';
import path from 'path';
import { mkdir } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import replaceStream from 'replacestream';
import glob from 'fast-glob';
import { GlobalConfig } from '@n8n/config';
import { jsonParse, randomString } from 'n8n-workflow';

import config from '@/config';
import { ActiveExecutions } from '@/ActiveExecutions';
import { ActiveWorkflowManager } from '@/ActiveWorkflowManager';
import { Server } from '@/Server';
import { EDITOR_UI_DIST_DIR, LICENSE_FEATURES } from '@/constants';
import { MessageEventBus } from '@/eventbus/MessageEventBus/MessageEventBus';
import { InternalHooks } from '@/InternalHooks';
import { License } from '@/License';
import { OrchestrationService } from '@/services/orchestration.service';
import { OrchestrationHandlerMainService } from '@/services/orchestration/main/orchestration.handler.main.service';
import { PruningService } from '@/services/pruning.service';
import { UrlService } from '@/services/url.service';
import { SettingsRepository } from '@db/repositories/settings.repository';
import { ExecutionRepository } from '@db/repositories/execution.repository';
import { FeatureNotLicensedError } from '@/errors/feature-not-licensed.error';
import { WaitTracker } from '@/WaitTracker';
import { BaseCommand } from './BaseCommand';
import type { IWorkflowExecutionDataProcess } from '@/Interfaces';
import { ExecutionService } from '@/executions/execution.service';
import { OwnershipService } from '@/services/ownership.service';
import { WorkflowRunner } from '@/WorkflowRunner';
import { ExecutionRecoveryService } from '@/executions/execution-recovery.service';
import { EventService } from '@/eventbus/event.service';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
const open = require('open');

export class Start extends BaseCommand {
	static description = 'Starts n8n. Makes Web-UI available and starts active workflows';

	static examples = [
		'$ n8n start',
		'$ n8n start --tunnel',
		'$ n8n start -o',
		'$ n8n start --tunnel -o',
	];

	static flags = {
		help: Flags.help({ char: 'h' }),
		open: Flags.boolean({
			char: 'o',
			description: 'opens the UI automatically in browser',
		}),
		tunnel: Flags.boolean({
			description:
				'runs the webhooks via a hooks.n8n.cloud tunnel server. Use only for testing and development!',
		}),
		reinstallMissingPackages: Flags.boolean({
			description:
				'Attempts to self heal n8n if packages with nodes are missing. Might drastically increase startup times.',
		}),
	};

	protected activeWorkflowManager: ActiveWorkflowManager;

	protected server = Container.get(Server);

	constructor(argv: string[], cmdConfig: Config) {
		super(argv, cmdConfig);
		this.setInstanceType('main');
		this.setInstanceQueueModeId();
	}

	/**
	 * Opens the UI in browser
	 */
	private openBrowser() {
		const editorUrl = Container.get(UrlService).baseUrl;

		open(editorUrl, { wait: true }).catch(() => {
			this.logger.info(
				`\nWas not able to open URL in browser. Please open manually by visiting:\n${editorUrl}\n`,
			);
		});
	}

	/**
	 * Stop n8n in a graceful way.
	 * Make for example sure that all the webhooks from third party services
	 * get removed.
	 */
	async stopProcess() {
		this.logger.info('\nStopping n8n...');

		try {
			// Stop with trying to activate workflows that could not be activated
			this.activeWorkflowManager.removeAllQueuedWorkflowActivations();

			Container.get(WaitTracker).stopTracking();

			await this.externalHooks?.run('n8n.stop', []);

			await this.activeWorkflowManager.removeAllTriggerAndPollerBasedWorkflows();

			if (Container.get(OrchestrationService).isMultiMainSetupEnabled) {
				await Container.get(OrchestrationService).shutdown();
			}

			await Container.get(InternalHooks).onN8nStop();

			await Container.get(ActiveExecutions).shutdown();

			// Finally shut down Event Bus
			await Container.get(MessageEventBus).close();
		} catch (error) {
			await this.exitWithCrash('There was an error shutting down n8n.', error);
		}

		await this.exitSuccessFully();
	}

	private async generateStaticAssets() {
		// Read the index file and replace the path placeholder
		const n8nPath = Container.get(GlobalConfig).path;
		const restEndpoint = config.getEnv('endpoints.rest');
		const hooksUrls = config.getEnv('externalFrontendHooksUrls');

		let scriptsString = '';
		if (hooksUrls) {
			scriptsString = hooksUrls.split(';').reduce((acc, curr) => {
				return `${acc}<script src="${curr}"></script>`;
			}, '');
		}

		const closingTitleTag = '</title>';
		const { staticCacheDir } = this.instanceSettings;
		const compileFile = async (fileName: string) => {
			const filePath = path.join(EDITOR_UI_DIST_DIR, fileName);
			if (/(index\.html)|.*\.(js|css)/.test(filePath) && existsSync(filePath)) {
				const destFile = path.join(staticCacheDir, fileName);
				await mkdir(path.dirname(destFile), { recursive: true });
				const streams = [
					createReadStream(filePath, 'utf-8'),
					replaceStream('/{{BASE_PATH}}/', n8nPath, { ignoreCase: false }),
					replaceStream('/%7B%7BBASE_PATH%7D%7D/', n8nPath, { ignoreCase: false }),
					replaceStream('/%257B%257BBASE_PATH%257D%257D/', n8nPath, { ignoreCase: false }),
					replaceStream('/static/', n8nPath + 'static/', { ignoreCase: false }),
				];
				if (filePath.endsWith('index.html')) {
					streams.push(
						replaceStream('{{REST_ENDPOINT}}', restEndpoint, { ignoreCase: false }),
						replaceStream(closingTitleTag, closingTitleTag + scriptsString, {
							ignoreCase: false,
						}),
					);
				}
				streams.push(createWriteStream(destFile, 'utf-8'));
				return await pipeline(streams);
			}
		};

		await compileFile('index.html');
		const files = await glob('**/*.{css,js}', { cwd: EDITOR_UI_DIST_DIR });
		await Promise.all(files.map(compileFile));
	}

	async init() {
		await this.initCrashJournal();

		this.logger.info('Initializing n8n process');
		if (config.getEnv('executions.mode') === 'queue') {
			this.logger.debug('Main Instance running in queue mode');
			this.logger.debug(`Queue mode id: ${this.queueModeId}`);
		}

		await super.init();
		this.activeWorkflowManager = Container.get(ActiveWorkflowManager);

		await this.initLicense();

		await this.initOrchestration();
		this.logger.debug('Orchestration init complete');

		if (
			!config.getEnv('license.autoRenewEnabled') &&
			config.getEnv('multiMainSetup.instanceType') === 'leader'
		) {
			this.logger.warn(
				'Automatic license renewal is disabled. The license will not renew automatically, and access to licensed features may be lost!',
			);
		}

		Container.get(WaitTracker).init();
		this.logger.debug('Wait tracker init complete');
		await this.initBinaryDataService();
		this.logger.debug('Binary data service init complete');
		await this.initExternalHooks();
		this.logger.debug('External hooks init complete');
		await this.initExternalSecrets();
		this.logger.debug('External secrets init complete');
		this.initWorkflowHistory();
		this.logger.debug('Workflow history init complete');

		if (!config.getEnv('endpoints.disableUi')) {
			await this.generateStaticAssets();
		}
	}

	async initOrchestration() {
		if (config.getEnv('executions.mode') === 'regular') {
			config.set('multiMainSetup.instanceType', 'leader');
			return;
		}

		if (
			config.getEnv('multiMainSetup.enabled') &&
			!Container.get(License).isMultipleMainInstancesLicensed()
		) {
			throw new FeatureNotLicensedError(LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES);
		}

		const orchestrationService = Container.get(OrchestrationService);

		await orchestrationService.init();

		await Container.get(OrchestrationHandlerMainService).init();

		if (!orchestrationService.isMultiMainSetupEnabled) return;

		orchestrationService.multiMainSetup
			.on('leader-stepdown', async () => {
				await this.license.reinit(); // to disable renewal
				await this.activeWorkflowManager.removeAllTriggerAndPollerBasedWorkflows();
			})
			.on('leader-takeover', async () => {
				await this.license.reinit(); // to enable renewal
				await this.activeWorkflowManager.addAllTriggerAndPollerBasedWorkflows();
			});
	}

	async run() {
		const { flags } = await this.parse(Start);

		// Load settings from database and set them to config.
		const databaseSettings = await Container.get(SettingsRepository).findBy({
			loadOnStartup: true,
		});
		databaseSettings.forEach((setting) => {
			config.set(setting.key, jsonParse(setting.value, { fallbackValue: setting.value }));
		});

		const globalConfig = Container.get(GlobalConfig);

		if (globalConfig.nodes.communityPackages.enabled) {
			const { CommunityPackagesService } = await import('@/services/communityPackages.service');
			await Container.get(CommunityPackagesService).setMissingPackages({
				reinstallMissingPackages: flags.reinstallMissingPackages,
			});
		}

		const { type: dbType } = globalConfig.database;
		if (dbType === 'sqlite') {
			const shouldRunVacuum = globalConfig.database.sqlite.executeVacuumOnStartup;
			if (shouldRunVacuum) {
				await Container.get(ExecutionRepository).query('VACUUM;');
			}
		}

		if (flags.tunnel) {
			this.log('\nWaiting for tunnel ...');

			let tunnelSubdomain =
				process.env.N8N_TUNNEL_SUBDOMAIN ?? this.instanceSettings.tunnelSubdomain ?? '';

			if (tunnelSubdomain === '') {
				// When no tunnel subdomain did exist yet create a new random one
				tunnelSubdomain = randomString(24).toLowerCase();

				this.instanceSettings.update({ tunnelSubdomain });
			}

			const { default: localtunnel } = await import('@n8n/localtunnel');
			const { port } = Container.get(GlobalConfig);

			const webhookTunnel = await localtunnel(port, {
				host: 'https://hooks.n8n.cloud',
				subdomain: tunnelSubdomain,
			});

			process.env.WEBHOOK_URL = `${webhookTunnel.url}/`;
			this.log(`Tunnel URL: ${process.env.WEBHOOK_URL}\n`);
			this.log(
				'IMPORTANT! Do not share with anybody as it would give people access to your n8n instance!',
			);
		}

		await this.server.start();

		Container.get(PruningService).init();
		Container.get(ExecutionRecoveryService).init();

		if (config.getEnv('executions.mode') === 'regular') {
			await this.runEnqueuedExecutions();
		}

		// Start to get active workflows and run their triggers
		await this.activeWorkflowManager.init();

		const editorUrl = Container.get(UrlService).baseUrl;
		this.log(`\nEditor is now accessible via:\n${editorUrl}`);

		// Allow to open n8n editor by pressing "o"
		if (Boolean(process.stdout.isTTY) && process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.setEncoding('utf8');

			if (flags.open) {
				this.openBrowser();
			}
			this.log('\nPress "o" to open in Browser.');
			process.stdin.on('data', (key: string) => {
				if (key === 'o') {
					this.openBrowser();
				} else if (key.charCodeAt(0) === 3) {
					// Ctrl + c got pressed
					void this.stopProcess();
				} else {
					// When anything else got pressed, record it and send it on enter into the child process

					if (key.charCodeAt(0) === 13) {
						// send to child process and print in terminal
						process.stdout.write('\n');
					} else {
						// record it and write into terminal
						process.stdout.write(key);
					}
				}
			});
		}
	}

	async catch(error: Error) {
		if (error.stack) this.logger.error(error.stack);
		await this.exitWithCrash('Exiting due to an error.', error);
	}

	/**
	 * During startup, we may find executions that had been enqueued at the time of shutdown.
	 *
	 * If so, start running any such executions concurrently up to the concurrency limit, and
	 * enqueue any remaining ones until we have spare concurrency capacity again.
	 */
	private async runEnqueuedExecutions() {
		const executions = await Container.get(ExecutionService).findAllEnqueuedExecutions();

		if (executions.length === 0) return;

		this.logger.debug(
			'[Startup] Found enqueued executions to run',
			executions.map((e) => e.id),
		);

		const ownershipService = Container.get(OwnershipService);
		const workflowRunner = Container.get(WorkflowRunner);

		for (const execution of executions) {
			const project = await ownershipService.getWorkflowProjectCached(execution.workflowId);

			const data: IWorkflowExecutionDataProcess = {
				executionMode: execution.mode,
				executionData: execution.data,
				workflowData: execution.workflowData,
				projectId: project.id,
			};

			Container.get(EventService).emit('execution-started-during-bootup', {
				executionId: execution.id,
			});

			// do not block - each execution either runs concurrently or is queued
			void workflowRunner.run(data, undefined, false, execution.id);
		}
	}
}
