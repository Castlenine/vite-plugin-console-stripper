import { Component } from '@angular/core';

@Component({
	selector: 'app-status',
	template: '<p>Status</p>',
})
class StatusComponent {
	constructor() {
		console.log('STRIP_ANGULAR_STATUS');
	}
}

export { StatusComponent };
