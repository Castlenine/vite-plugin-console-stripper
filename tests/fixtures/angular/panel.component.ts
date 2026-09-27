import type { OnDestroy } from '@angular/core';

import { Component } from '@angular/core';

@Component({
	selector: 'app-panel',
	templateUrl: './panel.component.html',
})
class PanelComponent implements OnDestroy {
	ngOnDestroy(): void {
		console.log('STRIP_ANGULAR_PANEL_DESTROY');
	}

	log(): void {
		console.trace('STRIP_ANGULAR_PANEL_CLICK');
		console.error('KEEP_ANGULAR_PANEL_ERROR');
		// console-stripper-ignore-start
		console.log('PROTECTED_ANGULAR_PANEL_RANGE');
		// console-stripper-ignore-end
	}
}

export { PanelComponent };
