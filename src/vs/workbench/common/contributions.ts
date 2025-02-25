/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService, IConstructorSignature, ServicesAccessor, BrandedService } from 'vs/platform/instantiation/common/instantiation';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import { IdleDeadline, DeferredPromise, runWhenGlobalIdle } from 'vs/base/common/async';
import { mark } from 'vs/base/common/performance';
import { ILogService } from 'vs/platform/log/common/log';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

/**
 * A workbench contribution that will be loaded when the workbench starts and disposed when the workbench shuts down.
 */
export interface IWorkbenchContribution {
	// Marker Interface
}

export namespace Extensions {
	export const Workbench = 'workbench.contributions.kind';
}

export const enum WorkbenchContributionInstantiation {

	/**
	 * The first phase signals that we are about to startup getting ready.
	 *
	 * Note: doing work in this phase blocks an editor from showing to
	 * the user, so please rather consider to use the other types, preferable
	 * `Lazy` to only instantiate the contribution when really needed.
	 */
	BlockStartup = LifecyclePhase.Starting,

	/**
	 * Services are ready and the window is about to restore its UI state.
	 *
	 * Note: doing work in this phase blocks an editor from showing to
	 * the user, so please rather consider to use the other types, preferable
	 * `Lazy` to only instantiate the contribution when really needed.
	 */
	BlockRestore = LifecyclePhase.Ready,

	/**
	 * Views, panels and editors have restored. Editors are given a bit of
	 * time to restore their contents.
	 */
	AfterRestored = LifecyclePhase.Restored,

	/**
	 * The last phase after views, panels and editors have restored and
	 * some time has passed (2-5 seconds).
	 */
	Eventually = LifecyclePhase.Eventually,

	/**
	 * The contribution is created only when explicitly requested via
	 * `getContribution()`.
	 */
	Lazy = LifecyclePhase.Eventually + 1
}

function toInstantiation(phase: LifecyclePhase): WorkbenchContributionInstantiation {
	switch (phase) {
		case LifecyclePhase.Starting:
			return WorkbenchContributionInstantiation.BlockStartup;
		case LifecyclePhase.Ready:
			return WorkbenchContributionInstantiation.BlockRestore;
		case LifecyclePhase.Restored:
			return WorkbenchContributionInstantiation.AfterRestored;
		case LifecyclePhase.Eventually:
			return WorkbenchContributionInstantiation.Eventually;
	}
}

function toPhase(instantiation: WorkbenchContributionInstantiation.BlockStartup | WorkbenchContributionInstantiation.BlockRestore | WorkbenchContributionInstantiation.AfterRestored | WorkbenchContributionInstantiation.Eventually): LifecyclePhase {
	switch (instantiation) {
		case WorkbenchContributionInstantiation.BlockStartup:
			return LifecyclePhase.Starting;
		case WorkbenchContributionInstantiation.BlockRestore:
			return LifecyclePhase.Ready;
		case WorkbenchContributionInstantiation.AfterRestored:
			return LifecyclePhase.Restored;
		case WorkbenchContributionInstantiation.Eventually:
			return LifecyclePhase.Eventually;
	}
}

type IWorkbenchContributionSignature<Service extends BrandedService[]> = new (...services: Service) => IWorkbenchContribution;

export interface IWorkbenchContributionsRegistry {

	/**
	 * @deprecated use `registerWorkbenchContribution2` instead.
	 */
	registerWorkbenchContribution<Services extends BrandedService[]>(contribution: IWorkbenchContributionSignature<Services>, phase: LifecyclePhase.Restored | LifecyclePhase.Eventually): void;

	/**
	 * Register a workbench contribution that will be instantiated
	 * based on the `instantiation` property.
	 */
	registerWorkbenchContribution2<Services extends BrandedService[]>(id: string, ctor: IWorkbenchContributionSignature<Services>, instantiation: WorkbenchContributionInstantiation): void;

	/**
	 * Provides access to a workbench contribution with a specific identifier.
	 * The contribution is created if not yet done.
	 *
	 * Note: will throw an error if
	 * - called too early before the registry has started
	 * - no contribution is known for the given identifier
	 */
	getWorkbenchContribution<T extends IWorkbenchContribution>(id: string): T;

	/**
	 * Starts the registry by providing the required services.
	 */
	start(accessor: ServicesAccessor): void;

	/**
	 * A promise that resolves when all contributions up to the `Restored`
	 * phase have been instantiated.
	 */
	readonly whenRestored: Promise<void>;

	/**
	 * Provides access to the instantiation times of all contributions by
	 * lifecycle phase.
	 */
	readonly timings: Map<LifecyclePhase, Array<[string /* ID */, number /* Creation Time */]>>;
}

interface IWorkbenchContributionRegistration {
	readonly id: string | undefined;
	readonly ctor: IConstructorSignature<IWorkbenchContribution>;
}

export class WorkbenchContributionsRegistry implements IWorkbenchContributionsRegistry {

	private static readonly BLOCK_BEFORE_RESTORE_WARN_THRESHOLD = 20;
	private static readonly BLOCK_AFTER_RESTORE_WARN_THRESHOLD = 100;

	private instantiationService: IInstantiationService | undefined;
	private lifecycleService: ILifecycleService | undefined;
	private logService: ILogService | undefined;
	private environmentService: IEnvironmentService | undefined;

	private readonly contributionsByPhase = new Map<LifecyclePhase, IWorkbenchContributionRegistration[]>();
	private readonly contributionsById = new Map<string, IWorkbenchContributionRegistration>();

	private readonly instancesById = new Map<string, IWorkbenchContribution>();

	private readonly timingsByPhase = new Map<LifecyclePhase, Array<[string /* ID */, number /* Creation Time */]>>();
	get timings() { return this.timingsByPhase; }

	private readonly pendingRestoredContributions = new DeferredPromise<void>();
	readonly whenRestored = this.pendingRestoredContributions.p;

	registerWorkbenchContribution2(id: string | undefined, ctor: IConstructorSignature<IWorkbenchContribution>, instantiation: WorkbenchContributionInstantiation): void {
		const contribution: IWorkbenchContributionRegistration = { id, ctor };

		// Instantiate directly if we are already matching the provided phase
		if (instantiation !== WorkbenchContributionInstantiation.Lazy && this.instantiationService && this.lifecycleService && this.logService && this.environmentService && this.lifecycleService.phase >= instantiation) {
			this.safeCreateContribution(this.instantiationService, this.logService, this.environmentService, contribution, toPhase(instantiation));
		}

		// Otherwise keep contributions by instantiation kind for later instantiation
		else {

			// by phase
			if (instantiation !== WorkbenchContributionInstantiation.Lazy) {
				const phase = toPhase(instantiation);
				let contributionsForPhase = this.contributionsByPhase.get(phase);
				if (!contributionsForPhase) {
					contributionsForPhase = [];
					this.contributionsByPhase.set(phase, contributionsForPhase);
				}

				contributionsForPhase.push(contribution);
			}

			// by id
			if (typeof id === 'string') {
				if (!this.contributionsById.has(id)) {
					this.contributionsById.set(id, contribution);
				} else {
					console.error(`IWorkbenchContributionsRegistry#registerWorkbenchContribution(): Can't register multiple contributions with same id '${id}'`);
				}
			}
		}
	}

	registerWorkbenchContribution(ctor: IConstructorSignature<IWorkbenchContribution>, phase: LifecyclePhase): void {
		this.registerWorkbenchContribution2(undefined, ctor, toInstantiation(phase));
	}

	getWorkbenchContribution<T extends IWorkbenchContribution>(id: string): T {
		if (this.instancesById.has(id)) {
			return this.instancesById.get(id) as T;
		}

		const instantiationService = this.instantiationService;
		const lifecycleService = this.lifecycleService;
		const logService = this.logService;
		const environmentService = this.environmentService;
		if (!instantiationService || !lifecycleService || !logService || !environmentService) {
			throw new Error(`IWorkbenchContributionsRegistry#getContribution('${id}'): cannot be called before registry started`);
		}

		const contribution = this.contributionsById.get(id);
		if (!contribution) {
			throw new Error(`IWorkbenchContributionsRegistry#getContribution('${id}'): contribution with that identifier is unknown.`);
		}

		const phase = lifecycleService.phase;
		if (phase < LifecyclePhase.Restored) {
			logService.warn(`IWorkbenchContributionsRegistry#getContribution('${id}'): lazy contribution instantiated before LifecyclePhase.Restored!`);
		}

		this.safeCreateContribution(instantiationService, logService, environmentService, contribution, lifecycleService.phase);

		const instance = this.instancesById.get(id);
		if (!instance) {
			throw new Error(`IWorkbenchContributionsRegistry#getContribution('${id}'): failed to create contribution.`);
		}

		return instance as T;
	}

	start(accessor: ServicesAccessor): void {
		const instantiationService = this.instantiationService = accessor.get(IInstantiationService);
		const lifecycleService = this.lifecycleService = accessor.get(ILifecycleService);
		const logService = this.logService = accessor.get(ILogService);
		const environmentService = this.environmentService = accessor.get(IEnvironmentService);

		for (const phase of [LifecyclePhase.Starting, LifecyclePhase.Ready, LifecyclePhase.Restored, LifecyclePhase.Eventually]) {
			this.instantiateByPhase(instantiationService, lifecycleService, logService, environmentService, phase);
		}
	}

	private instantiateByPhase(instantiationService: IInstantiationService, lifecycleService: ILifecycleService, logService: ILogService, environmentService: IEnvironmentService, phase: LifecyclePhase): void {

		// Instantiate contributions directly when phase is already reached
		if (lifecycleService.phase >= phase) {
			this.doInstantiateByPhase(instantiationService, logService, environmentService, phase);
		}

		// Otherwise wait for phase to be reached
		else {
			lifecycleService.when(phase).then(() => this.doInstantiateByPhase(instantiationService, logService, environmentService, phase));
		}
	}

	private async doInstantiateByPhase(instantiationService: IInstantiationService, logService: ILogService, environmentService: IEnvironmentService, phase: LifecyclePhase): Promise<void> {
		const contributions = this.contributionsByPhase.get(phase);
		if (contributions) {
			this.contributionsByPhase.delete(phase);

			switch (phase) {
				case LifecyclePhase.Starting:
				case LifecyclePhase.Ready: {

					// instantiate everything synchronously and blocking
					// measure the time it takes as perf marks for diagnosis

					mark(`code/willCreateWorkbenchContributions/${phase}`);

					for (const contribution of contributions) {
						this.safeCreateContribution(instantiationService, logService, environmentService, contribution, phase);
					}

					mark(`code/didCreateWorkbenchContributions/${phase}`);

					break;
				}

				case LifecyclePhase.Restored:
				case LifecyclePhase.Eventually: {

					// for the Restored/Eventually-phase we instantiate contributions
					// only when idle. this might take a few idle-busy-cycles but will
					// finish within the timeouts
					// given that, we must ensure to await the contributions from the
					// Restored-phase before we instantiate the Eventually-phase

					if (phase === LifecyclePhase.Eventually) {
						await this.pendingRestoredContributions.p;
					}

					this.doInstantiateWhenIdle(contributions, instantiationService, logService, environmentService, phase);

					break;
				}
			}
		}
	}

	private doInstantiateWhenIdle(contributions: IWorkbenchContributionRegistration[], instantiationService: IInstantiationService, logService: ILogService, environmentService: IEnvironmentService, phase: LifecyclePhase): void {
		mark(`code/willCreateWorkbenchContributions/${phase}`);

		let i = 0;
		const forcedTimeout = phase === LifecyclePhase.Eventually ? 3000 : 500;

		const instantiateSome = (idle: IdleDeadline) => {
			while (i < contributions.length) {
				const contribution = contributions[i++];
				this.safeCreateContribution(instantiationService, logService, environmentService, contribution, phase);
				if (idle.timeRemaining() < 1) {
					// time is up -> reschedule
					runWhenGlobalIdle(instantiateSome, forcedTimeout);
					break;
				}
			}

			if (i === contributions.length) {
				mark(`code/didCreateWorkbenchContributions/${phase}`);

				if (phase === LifecyclePhase.Restored) {
					this.pendingRestoredContributions.complete();
				}
			}
		};

		runWhenGlobalIdle(instantiateSome, forcedTimeout);
	}

	private safeCreateContribution(instantiationService: IInstantiationService, logService: ILogService, environmentService: IEnvironmentService, contribution: IWorkbenchContributionRegistration, phase: LifecyclePhase): void {
		if (typeof contribution.id === 'string' && this.instancesById.has(contribution.id)) {
			return;
		}

		const now = Date.now();

		try {
			if (typeof contribution.id === 'string') {
				mark(`code/willCreateWorkbenchContribution/${phase}/${contribution.id}`);
			}

			const instance = instantiationService.createInstance(contribution.ctor);
			if (typeof contribution.id === 'string') {
				this.instancesById.set(contribution.id, instance);
				this.contributionsById.delete(contribution.id);
			}
		} catch (error) {
			logService.error(`Unable to create workbench contribution '${contribution.id ?? contribution.ctor.name}'.`, error);
		} finally {
			if (typeof contribution.id === 'string') {
				mark(`code/didCreateWorkbenchContribution/${phase}/${contribution.id}`);
			}
		}

		if (typeof contribution.id === 'string' || !environmentService.isBuilt /* only log out of sources where we have good ctor names (TODO@bpasero remove when adopted IDs) */) {
			const time = Date.now() - now;
			if (time > (phase < LifecyclePhase.Restored ? WorkbenchContributionsRegistry.BLOCK_BEFORE_RESTORE_WARN_THRESHOLD : WorkbenchContributionsRegistry.BLOCK_AFTER_RESTORE_WARN_THRESHOLD)) {
				logService.warn(`Creation of workbench contribution '${contribution.id ?? contribution.ctor.name}' took ${time}ms.`);
			}

			if (typeof contribution.id === 'string') {
				let timingsForPhase = this.timingsByPhase.get(phase);
				if (!timingsForPhase) {
					timingsForPhase = [];
					this.timingsByPhase.set(phase, timingsForPhase);
				}

				timingsForPhase.push([contribution.id, time]);
			}
		}
	}
}

Registry.add(Extensions.Workbench, new WorkbenchContributionsRegistry());
