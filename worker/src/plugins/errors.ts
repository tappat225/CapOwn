// SPDX-License-Identifier: Apache-2.0

export class PluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly safeMessage: string = message,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export const PluginErrorCodes = {
  PluginNotFound: "plugin_not_found",
  PluginDisabled: "plugin_disabled",
  PluginUnavailable: "plugin_unavailable",
  PluginToolNotFound: "plugin_tool_not_found",
  PluginSchemaInvalid: "plugin_schema_invalid",
  PluginTimeout: "plugin_timeout",
  PluginCanceled: "plugin_canceled",
  PluginOutputTooLarge: "plugin_output_too_large",
  PluginProtocolError: "plugin_protocol_error",
  PluginConcurrencyExceeded: "plugin_concurrency_exceeded",
} as const;
