import type { OnInit } from '@angular/core';

import { Component } from '@angular/core';

import { IgnoredComponent } from './ignored.component';
import { PanelComponent } from './panel.component';
import { StatusComponent } from './status.component';

@Component({
	selector: 'app-root',
	imports: [IgnoredComponent, PanelComponent, StatusComponent],
	template: `
		<button (click)="log()">Type console.log(inline) to debug</button>
		<app-panel />
		<app-ignored />
		<app-status />
	`,
})
class AppComponent implements OnInit {
	constructor() {
		console.log('STRIP_ANGULAR_CONSTRUCTOR');
	}

	ngOnInit(): void {
		console.debug('STRIP_ANGULAR_ON_INIT');
		console.warn('KEEP_ANGULAR_ON_INIT_WARN');
		// console-stripper-ignore-next-line
		console.log('PROTECTED_ANGULAR_ON_INIT');
	}

	log(): void {
		console.log('STRIP_ANGULAR_CLICK');
	}
}

export { AppComponent };
