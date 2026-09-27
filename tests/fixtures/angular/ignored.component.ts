// console-stripper-ignore
import type { OnInit } from '@angular/core';

import { Component } from '@angular/core';

@Component({
	selector: 'app-ignored',
	template: '<p>Keep console.log(ignored) as text</p>',
})
class IgnoredComponent implements OnInit {
	ngOnInit(): void {
		console.log('PROTECTED_ANGULAR_FILE');
	}
}

export { IgnoredComponent };
