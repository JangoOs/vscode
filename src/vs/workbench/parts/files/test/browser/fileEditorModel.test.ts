/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import {TPromise} from 'vs/base/common/winjs.base';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import URI from 'vs/base/common/uri';
import {FileEditorInput} from 'vs/workbench/parts/files/common/editors/fileEditorInput';
import paths = require('vs/base/common/paths');
import {EncodingMode} from 'vs/workbench/common/editor';
import {TextFileEditorModel} from 'vs/workbench/parts/files/common/editors/textFileEditorModel';
import {IEventService} from 'vs/platform/event/common/event';
import {ITextFileService, ModelState, StateChange} from 'vs/workbench/parts/files/common/files';
import {workbenchInstantiationService, TestTextFileService} from 'vs/test/utils/servicesTestUtils';
import {TextFileEditorModelManager} from 'vs/workbench/parts/files/common/editors/textFileEditorModelManager';
import {FileOperationResult, IFileOperationResult} from 'vs/platform/files/common/files';

function toResource(path) {
	return URI.file(paths.join('C:\\', path));
}

class ServiceAccessor {
	constructor( @IEventService public eventService: IEventService, @ITextFileService public textFileService: TestTextFileService) {
	}
}

suite('Files - TextFileEditorModel', () => {

	let instantiationService: IInstantiationService;
	let accessor: ServiceAccessor;

	setup(() => {
		instantiationService = workbenchInstantiationService();
		accessor = instantiationService.createInstance(ServiceAccessor);
	});

	teardown(() => {
		(<TextFileEditorModelManager>accessor.textFileService.models).clear();
		TextFileEditorModel.setSaveParticipant(null); // reset any set participant
	});

	test('Save', function (done) {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.load().then(() => {
			model.textEditorModel.setValue('bar');
			assert.ok(model.getLastModifiedTime() <= Date.now());

			return model.save().then(() => {
				assert.ok(model.getLastSaveAttemptTime() <= Date.now());
				assert.ok(!model.isDirty());

				model.dispose();

				done();
			});
		});
	});

	test('setEncoding - encode', function () {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.setEncoding('utf8', EncodingMode.Encode); // no-op
		assert.equal(model.getLastModifiedTime(), -1);

		model.setEncoding('utf16', EncodingMode.Encode);

		assert.ok(model.getLastModifiedTime() <= Date.now()); // indicates model was saved due to encoding change

		model.dispose();
	});

	test('setEncoding - decode', function () {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.setEncoding('utf16', EncodingMode.Decode);

		assert.ok(model.isResolved()); // model got loaded due to decoding

		model.dispose();
	});

	test('disposes when underlying model is destroyed', function (done) {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.load().then(() => {
			model.textEditorModel.destroy();

			assert.ok(model.isDisposed());

			done();
		});
	});

	test('Load does not trigger save', function (done) {
		const model = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index.txt'), 'utf8');
		assert.equal(model.getState(), ModelState.SAVED);

		accessor.eventService.addListener2('files:internalFileChanged', () => {
			assert.ok(false);
		});

		model.onDidStateChange(e => {
			assert.ok(e !== StateChange.DIRTY && e !== StateChange.SAVED);
		});

		model.load().then(() => {
			assert.ok(model.isResolved());

			model.dispose();

			done();
		});
	});

	test('Load returns dirty model as long as model is dirty', function (done) {
		const model = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.load().then(() => {
			model.textEditorModel.setValue('foo');

			assert.ok(model.isDirty());
			assert.equal(model.getState(), ModelState.DIRTY);
			model.load().then(() => {
				assert.ok(model.isDirty());

				model.dispose();

				done();
			});
		});
	});

	test('Revert', function (done) {
		let eventCounter = 0;


		const model = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.onDidStateChange(e => {
			if (e === StateChange.REVERTED) {
				eventCounter++;
			}
		});

		model.load().then(() => {
			model.textEditorModel.setValue('foo');

			assert.ok(model.isDirty());

			model.revert().then(() => {
				assert.ok(!model.isDirty());
				assert.equal(model.textEditorModel.getValue(), 'Hello Html');
				assert.equal(eventCounter, 1);

				model.dispose();

				done();
			});
		});
	});

	test('File not modified error is handled gracefully', function (done) {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.load().then(() => {
			const mtime = model.getLastModifiedTime();
			accessor.textFileService.setResolveTextContentErrorOnce(<IFileOperationResult>{
				message: 'error',
				fileOperationResult: FileOperationResult.FILE_NOT_MODIFIED_SINCE
			});

			model.load().then((model: TextFileEditorModel) => {
				assert.ok(model);
				assert.equal(model.getLastModifiedTime(), mtime);
				model.dispose();

				done();
			});
		});
	});

	test('Conflict Resolution Mode', function (done) {
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.load().then(() => {
			model.setConflictResolutionMode();
			model.textEditorModel.setValue('foo');

			assert.ok(model.isDirty());
			assert.equal(model.getState(), ModelState.CONFLICT);
			assert.ok(model.isInConflictResolutionMode());

			model.revert().then(() => {
				model.textEditorModel.setValue('bar');
				assert.ok(model.isDirty());

				return model.save().then(() => {
					assert.ok(!model.isDirty());

					model.dispose();

					done();
				});
			});
		});
	});

	test('Auto Save triggered when model changes', function (done) {
		let eventCounter = 0;
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index.txt'), 'utf8');

		(<any>model).autoSaveAfterMillies = 10;
		(<any>model).autoSaveAfterMilliesEnabled = true;

		model.onDidStateChange(e => {
			if (e === StateChange.DIRTY || e === StateChange.SAVED) {
				eventCounter++;
			}
		});

		model.load().then(() => {
			model.textEditorModel.setValue('foo');

			return TPromise.timeout(50).then(() => {
				assert.ok(!model.isDirty());
				assert.equal(eventCounter, 2);

				model.dispose();

				done();
			});
		});
	});

	test('save() and isDirty() - proper with check for mtimes', function (done) {
		const input1 = instantiationService.createInstance(FileEditorInput, toResource('/path/index_async2.txt'), 'text/plain', 'utf8');
		const input2 = instantiationService.createInstance(FileEditorInput, toResource('/path/index_async.txt'), 'text/plain', 'utf8');

		input1.resolve().then((model1: TextFileEditorModel) => {
			input2.resolve().then((model2: TextFileEditorModel) => {
				model1.textEditorModel.setValue('foo');

				const m1Mtime = model1.getLastModifiedTime();
				const m2Mtime = model2.getLastModifiedTime();
				assert.ok(m1Mtime > 0);
				assert.ok(m2Mtime > 0);

				assert.ok(accessor.textFileService.isDirty());
				assert.ok(accessor.textFileService.isDirty(toResource('/path/index_async2.txt')));
				assert.ok(!accessor.textFileService.isDirty(toResource('/path/index_async.txt')));

				model2.textEditorModel.setValue('foo');
				assert.ok(accessor.textFileService.isDirty(toResource('/path/index_async.txt')));

				return TPromise.timeout(10).then(() => {
					accessor.textFileService.saveAll().then(() => {
						assert.ok(!accessor.textFileService.isDirty(toResource('/path/index_async.txt')));
						assert.ok(!accessor.textFileService.isDirty(toResource('/path/index_async2.txt')));
						assert.ok(model1.getLastModifiedTime() > m1Mtime);
						assert.ok(model2.getLastModifiedTime() > m2Mtime);
						assert.ok(model1.getLastSaveAttemptTime() > m1Mtime);
						assert.ok(model2.getLastSaveAttemptTime() > m2Mtime);

						model1.dispose();
						model2.dispose();

						done();
					});
				});
			});
		});
	});

	test('Save Participant', function (done) {
		let eventCounter = 0;
		const model: TextFileEditorModel = instantiationService.createInstance(TextFileEditorModel, toResource('/path/index_async.txt'), 'utf8');

		model.onDidStateChange(e => {
			if (e === StateChange.SAVED) {
				assert.equal(model.getValue(), 'bar');
				assert.ok(!model.isDirty());
				eventCounter++;
			}
		});

		TextFileEditorModel.setSaveParticipant({
			participate: (model) => {
				assert.ok(model.isDirty());
				model.textEditorModel.setValue('bar');
				assert.ok(model.isDirty());
				eventCounter++;
			}
		});

		model.load().then(() => {
			model.textEditorModel.setValue('foo');

			model.save().then(() => {
				model.dispose();

				assert.equal(eventCounter, 2);

				done();
			});
		});
	});
});