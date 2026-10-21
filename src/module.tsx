import { AppPlugin } from '@grafana/data';
import { App } from './app/components/App';

export const plugin = new AppPlugin<{}>().setRootPage(App);
