package main

import (
	"fmt"
	"os"

	sdklog "github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/app"
)

// appPluginID must match src/plugin.json.
const appPluginID = "ahfuzhang-victoriametricsexplorer-app"

func main() {
	sdklog.DefaultLogger.Info("starting VictoriaMetrics Explorer backend", "pluginID", appPluginID)

	if err := app.Manage(appPluginID); err != nil {
		sdklog.DefaultLogger.Error("plugin failed", "pluginID", appPluginID, "error", err)
		fmt.Fprintf(os.Stderr, "plugin %s failed: %v\n", appPluginID, err)
		os.Exit(1)
	}
}
