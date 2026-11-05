import { Effect, Layer } from "effect";
import { Runtime } from "foldkit";
import { AdminUi, liveAdminUi } from "#/platform/admin-ui.ts";
import { Flags, initialModel, Model } from "#/features/configuration/model.ts";
import { ports } from "#/features/configuration/ports.ts";
import { update } from "#/features/configuration/update.ts";
import { view } from "#/features/configuration/view.ts";

export function makeConfigurationElement(container: HTMLElement, flags: Flags) {
	return Runtime.makeElement({
		Model,
		Flags,
		flags: Effect.succeed(flags),
		init: (resolved) => ({ model: initialModel(resolved) }),
		update,
		view,
		ports,
		container,
		resources: Layer.succeed(AdminUi, liveAdminUi),
	});
}
