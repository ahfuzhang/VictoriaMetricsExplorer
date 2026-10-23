import { AppPlugin } from '@grafana/data';
import { App } from './app/components/App';
import { AppConfig } from './app/components/AppConfig';

export const plugin = new AppPlugin<{}>().setRootPage(App).addConfigPage({
  title: 'Configuration',
  icon: 'cog',
  body: AppConfig,
  id: 'configuration',
});
