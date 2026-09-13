import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

// Regression coverage for #6744: prompt startup is not serialized, so two prompts
// arriving in the same tick both observe an idle session, both run async preflight,
// and the second reaches `Agent.prompt()` while the first run is active — where it
// throws "Agent is already processing a prompt" and is silently dropped. The
// extension `sendUserMessage` surface is fire-and-forget and cannot observe that
// rejection, so a caller sees success while the message never reaches the transcript.
describe("concurrent prompt startup (#6744)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues the second of two extension sends issued in the same tick", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);

		const results = await Promise.allSettled([
			harness.session.sendUserMessage("first", { deliverAs: "steer" }),
			harness.session.sendUserMessage("second", { deliverAs: "steer" }),
		]);
		await harness.session.agent.waitForIdle();

		expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
	});

	it("delivers a steer sent while a run started by a racing send is active", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};

		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "mid-run steer",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		// Fire two sends in the same tick while idle. One starts the blocking run.
		harness.session.sendUserMessage("first", { deliverAs: "steer" }).catch(() => {});
		harness.session.sendUserMessage("second", { deliverAs: "steer" }).catch(() => {});

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The run is active; this must queue rather than be dropped.
		extensionApi?.sendUserMessage("mid-run steer", { deliverAs: "steer" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		releaseToolExecution?.();
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toContain("mid-run steer");
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});
});
