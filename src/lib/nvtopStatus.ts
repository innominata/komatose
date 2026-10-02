/** What Admin → Hardware shows for the nvtop Komatose builds for itself. */
export type NvtopBuildState = 'missing' | 'ready' | 'running' | 'failed';

export type NvtopStatus = {
	state: NvtopBuildState;
	/** The owned binary is installed and stamped as this patched build. */
	ready: boolean;
	/** SCAN_NVTOP is set and that file exists, so it is used instead of the owned binary. */
	override: boolean;
	/** The binary the next snapshot will run, when one is available. */
	path: string;
	error: string;
	lines: string[];
	version: string;
};
