'use strict'

const fs = require('fs');
const path = require('path');
let _;
const validationHelper = require('./validationHelper');
const { setDependencies, dependencies } = require('./appDependencies');

const ADDITIONAL_PROPS = ['description', 'order', 'aliases', 'symbols', 'namespace', 'default'];
const ADDITIONAL_CHOICE_META_PROPS = ADDITIONAL_PROPS.concat('index');
const PRIMITIVE_FIELD_ATTRIBUTES = ['order', 'logicalType', 'precision', 'scale', 'aliases'];
const DEFAULT_TYPE = 'string';
const DEFAULT_NAME = 'New_field';
const VALID_FULL_NAME_REGEX = /[^A-Za-z0-9_]/g;
const VALID_FIRST_NAME_LETTER_REGEX = /^[0-9]/;
const AVRO_TYPES = [
	'string',
	'boolean',
	'bytes',
	'null',
	'array',
	'record',
	'enum',
	'fixed',
	'number',
	'map',
]
const readConfig = (pathToConfig) => {
	return JSON.parse(fs.readFileSync(path.join(__dirname, pathToConfig)).toString().replace(/(\/\*[.\s\S]*?\*\/|\/\/.*)/ig, ""));
};
const fieldLevelConfig = readConfig('../properties_pane/field_level/fieldLevelConfig.json');
let nameIndex = 0;

const LOGICAL_TYPES_MAP = {
	bytes: ['decimal'],
	int: [
		'date',
		'time-millis'
	],
	long: [
		'time-micros',
		'timestamp-millis',
		'timestamp-micros',
		'local-timestamp-millis',
		'local-timestamp-micros',
	],
	fixed: ['decimal', 'duration']
};

const RecordNameStrategy = 'RecordNameStrategy';
const TopicRecordNameStrategy = 'TopicRecordNameStrategy';
module.exports = {
	generateModelScript(data, logger, cb, app) {
		logger.clear();
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			const commonData = getCommonEntitiesData(data);
			const containers = dependencies.lodash.get(data, 'containers', []);
			const script = containers.reduce((createdQueries, container) => {
				const containerEntities = container.entities.map(entityId => {
					return Object.assign({}, commonData, getEntityData(container, entityId))
				})

				const containerQueries = containerEntities.map(entity => {
					try {
						return getScript(entity)
					} catch (err) {
						logger.log('error', { message: err.message, stack: err.stack }, 'Avro Forward-Engineering Error');
						return '';
					}
				})

				return [...createdQueries, ...containerQueries];
			}, [])
			cb(null, script.join('\n\n'));
		} catch (err) {
			logger.log('error', { message: err.message, stack: err.stack }, 'Avro model Forward-Engineering Error');
			cb({ message: err.message, stack: err.stack });
		}
	},
	generateScript(data, logger, cb, app) {
		logger.clear();
		try {
			setDependencies(app);
			_ = dependencies.lodash;
			const script = getScript(data);
			cb(null, script)
		} catch (err) {
			nameIndex = 0;
			logger.log('error', { message: err.message, stack: err.stack }, 'Avro Forward-Engineering Error');
			cb({ message: err.message, stack: err.stack });
		}
	},
	validate(data, logger, cb, app) {
		setDependencies(app);
		_ = dependencies.lodash;
		const targetScript = data.script;
		const targetScriptOptions = data.targetScriptOptions.keyword || data.targetScriptOptions.format;
		const parsedScripts = parseScript(targetScript,targetScriptOptions);
		let validateScript;
		if(targetScriptOptions === 'azureSchemaRegistry'){
			validateScript = validateAzureScript;
		} else if(targetScriptOptions === 'pulsarSchemaRegistry'){
			validateScript = validatePulsarScript;
		} else {
			validateScript = validateScriptGeneral;
		}

		if (parsedScripts.length === 1) {
			return cb(null, validateScript(_.first(parsedScripts), logger))
		}

		const validationMessages = parsedScripts.reduce((messages, script) => messages.concat(validateScript(script, logger)), [])
		return cb(null, getMessageForMultipleSchemaValidation(validationMessages))
	}
};

const validateScriptGeneral = ({ script }, logger) => validateScript(script, logger);

const validatePulsarScript = ({ script, query }, logger) => {
	const queryIsCorrect = /\/.+\/.+\/.+\/schema/.test(query);
	if (queryIsCorrect) {
		return validateScript(script, logger)
	}

	let validationErrors = [];
	const namespaceExists = /.+\/.+\/.*\/schema/.test(query);
	const topicExists = /.+\/.*\/.+\/schema/.test(query);

	if(!namespaceExists){
		validationErrors = [...validationErrors, {
			title: 'Pulsar namespace is missing',
			type: 'error',
			label: '',
			context: ''
		}]
	}
	if(!topicExists){
		validationErrors = [...validationErrors, {
			title: 'Pulsar topic is missing',
			type: 'error',
			label: '',
			context: ''
		}]	
	}

	return validationErrors;
}

const validateAzureScript = ({ script, query }, logger) => {
	const schemaGroupExist = /.+\/schemas/.test(query);
	if (schemaGroupExist) {
		return validateScript(script, logger)
	}

	const title = 'Schema Group is missing';
	try {
		const { namespace = '' } = JSON.parse(script);

		return [{
			title,
			type: 'error',
			label: namespace,
			context: ''
		}]
	} catch (e) {
		return [{
			title,
			type: 'error',
			label: '',
			context: ''
		}]
	}
}

const getMessageForMultipleSchemaValidation = (validationMessages)=>{
	const isError = validationMessages.some(({ type }) => type !== 'success');

	if (isError) {
		return validationMessages.filter(({ type }) => type !== 'success')
	}

	return [{
		type: "success",
		label: "",
		title: "Avro schemas are valid",
		context: "",
	}]
}

const parseScript = (script, targetScriptOption) =>{
	switch(targetScriptOption){
		case 'confluentSchemaRegistry':
			return parseConfluentScript(script);
		case 'azureSchemaRegistry':
			return parseAzureScript(script);
		case 'pulsarSchemaRegistry':
			return parsePulsarScript(script);
		case 'schemaRegistry':
			return [{ script: JSON.parse(script).schema }]
		default:
			return [{ script }]
	}
}

const parseAzureScript = script => {
	const getScripts = script => {
		const defaultScripts = [...script.matchAll(/^PUT \/(.*)$\n(^\{[\s\S]*?^\})/gm)];

		if (defaultScripts.length) {
			return defaultScripts;
		}

		return [...script.matchAll(/^PUT \/(.*)\n(\{[\s\S]*?}$)/gm)];
	};
	const scripts = getScripts(script);

	return scripts.map(([data, query, script]) => ({ script, query }));
};

const parsePulsarScript = script => {
	const getScripts = script => {
		const defaultScripts = [...script.matchAll(/^POST \/(.*)$\n(^\{[\s\S]*?^\})/gm)];

		if (defaultScripts.length) {
			return defaultScripts;
		}

		return [...script.matchAll(/^POST \/(.*)\n(\{[\s\S]*?}$)/gm)];
	};
	const scripts = getScripts(script);

	return scripts.map(([data, query, script]) => ({ script, query }));
};

const parseConfluentScript = script => {
	const scripts = [...script.matchAll(/^POST \/(.*)$\n(^\{[\s\S]*?^\})/gm)];

	return scripts.map(([data, queryPath, stringifiedBody]) => {
		const jsonBody = JSON.parse(stringifiedBody);
		if (_.isPlainObject(jsonBody.schema)) {
			return { script: JSON.stringify(jsonBody.schema) }
		}

		return { script: jsonBody.schema }
	});
};

const validateScript = (targetScript, logger) => {
	try {
		return validationHelper.validate(targetScript);
	} catch (e) {
		logger.log('error', { error: e }, 'Avro Validation Error');
		return [{
			type: 'error',
			label: e.fieldName || e.name,
			title: e.message,
			context: ''
		}];
	}
}

const getCommonEntitiesData = (data) => {
	const { modelDefinitions, externalDefinitions } = data;
	const options = {
		targetScriptOptions: {
			keyword: _.get(data, 'targetScriptOptions.format', 'confluentSchemaRegistry'),
		},
		additionalOptions: data.options.additionalOptions
	};
	const modelData = _.get(data, 'modelData[0]', {})

	return { options, modelDefinitions, externalDefinitions, modelData }
}

const getEntityData = (container, entityId) => {
	const containerData = _.first(_.get(container, 'containerData', []));
	const jsonSchema = container.jsonSchema[entityId];
	const jsonData = container.jsonData[entityId];
	const entityData = _.first(container.entityData[entityId]);
	const internalDefinitions = container.internalDefinitions[entityId];

	return { containerData, jsonSchema, jsonData, entityData, internalDefinitions }
}

const getConfluentPostQuery = ({ data, schema }) => {
	const getName = ()=>{
		const name = getRecordName(data);
		const typePostfix = _.has(data, 'entityData.schemaType') ? `-${data.entityData.schemaType}` : '';
		const containerPrefix = _.has(data, 'containerData.name') ? `${data.containerData.name}.`:'';
		const topicPrefix = _.has(data, 'modelData.schemaTopic') ? `${data.modelData.schemaTopic}-`:'';

		const schemaNameStrategy = _.get(data, 'modelData.schemaNameStrategy', '');
		switch(schemaNameStrategy){
			case RecordNameStrategy:
				return `${containerPrefix}${name}${typePostfix}`
			case TopicRecordNameStrategy:
				return `${topicPrefix}${containerPrefix}${name}${typePostfix}`
			default:
				return `${name}${typePostfix}`;
		}
	}

	return `POST /subjects/${getName()}/versions\n${JSON.stringify(
		{ schema, schemaType: "AVRO" },
		null,
		4
	)}`;
};

const getScript = (data) => {
	const name = getRecordName(data);
	let avroSchema = { name };
	let jsonSchema = JSON.parse(data.jsonSchema);
	const udt = getUserDefinedTypes(data);

	jsonSchema.type = 'root';
	handleRecursiveSchema(jsonSchema, avroSchema, {}, udt);

	if (data.containerData) {
		avroSchema.namespace = data.containerData.name;
	}
	avroSchema.type = 'record';
	avroSchema = reorderAvroSchema(avroSchema);
	avroSchema = resolveUdt(avroSchema, udt);
	const options = data.options;
	const additionalOptions = _.get(options, 'additionalOptions', []);
	const targetScriptType = _.get(options, 'targetScriptOptions.keyword');
	nameIndex = 0;

	const needMinify = (additionalOptions.find(option => option.id === 'minify') || {}).value;
	if (targetScriptType === 'confluentSchemaRegistry') {
		const schema = needMinify ? JSON.stringify(avroSchema) : avroSchema;

		return getConfluentPostQuery({ data, schema});
	}

	if (targetScriptType === "schemaRegistry") {
		return JSON.stringify({ schema: JSON.stringify(avroSchema) }, null, needMinify ? 0 : 4);
	}

	if (targetScriptType === 'azureSchemaRegistry') {
		const schema = needMinify ? JSON.stringify(avroSchema) : JSON.stringify(avroSchema, null, 4);
		const schemaGroupName = _.get(data, 'containerData.schemaGroupName', '');

		return `PUT /${schemaGroupName}/schemas/${name}?api-version=2020-09-01-preview\n${schema}`
	}

	if (targetScriptType === 'pulsarSchemaRegistry') {
		const bodyObject = {
			type: "AVRO",
			data: avroSchema,
			properties: {}
		}
		const schema = needMinify ? JSON.stringify(bodyObject) : JSON.stringify(bodyObject, null, 4);

		const namespace = _.get(data, 'containerData.name', '');
		const topic = _.get(data, 'entityData.pulsarTopicName', '');
		const persistence = _.get(data, 'entityData.isNonPersistentTopic', false) ? 'non-persistent' : 'persistent';
		return `POST /${persistence}/${namespace}/${topic}/schema\n${schema}`
	}

	if (needMinify) {
		return JSON.stringify(avroSchema);
	}

	return JSON.stringify(avroSchema, null, 4);
}

const getUserDefinedTypes = ({ internalDefinitions, externalDefinitions, modelDefinitions }) => {
	let udt = convertSchemaToUserDefinedTypes(JSON.parse(externalDefinitions), {});
	 udt = convertSchemaToUserDefinedTypes(JSON.parse(modelDefinitions), udt);
	 udt = convertSchemaToUserDefinedTypes(JSON.parse(internalDefinitions), udt);

	return udt;
};

const resolveUdt = (avroSchema, udt) => {
	return mapAvroSchema(avroSchema, schema => {
		if (_.isString(schema.items)) {
			schema = {
				...schema,
				items: getTypeFromUdt(schema.items, udt, schema),
			};
		}
		if (_.isArray(schema.items)) {
			schema = {
				...schema,
				items: schema.items.map(type => getTypeFromUdt(type, udt, schema))
			};
		}

		if (_.isPlainObject(schema.items) && schema.items.type) {
			const typeFromUdt = getTypeFromUdt(schema.items.type, udt, schema);
			if (_.isPlainObject(typeFromUdt)) {
				schema = {
					...schema,
					items: { ...schema.items, ...typeFromUdt }
				};
			}
		}
		if (_.isArray(schema.type)) {
			return {
				...schema,
				type: schema.type.map(type => getTypeFromUdt(type, udt, schema))
			}
		}

		if (schema?.type?.type) {
			return schema;
		}

		const typeFromUdt = getTypeFromUdt(schema.type, udt, schema);
		if (_.isArray(_.get(typeFromUdt, 'type'))) {
			return { ...schema, ...typeFromUdt, name: schema.name };
		}

		return { ...schema, ...prepareTypeFromUDT(typeFromUdt) };
	});
};

const convertSchemaToUserDefinedTypes = (definitionsSchema, udt) => {
	const avroSchema = {};
	const jsonSchema = definitionsSchema;

	handleRecursiveSchema(jsonSchema, avroSchema, {}, udt);

	return (avroSchema.fields || []).reduce((result, field) => {
		if (_.isPlainObject(field.type)) {
			return {
				...result,
				[field.name]: {
					...field,
					...field.type, 
					name: field.name,
				},
			};
		}

		if (_.isArray(field.type)) {
			return { ...result, [field.name]: field	};
		}

		const props = Object.keys(field);
		const needToSimplify = (props.length === 1 || (props.length === 2 && props.includes('name')));
		if (needToSimplify) {
			return {
				...result,
				[field.name]: field.type,
			};
		}

		return {
			...result,
			[field.name]: { ..._.omit(field, 'name') }
		};
	}, udt);
};

const getRecordName = (data) => {
	return (
		data.entityData.code
		||
		data.entityData.name
		||
		data.entityData.collectionName
	);
};

const reorderAvroSchema = (avroSchema) => {
	const schemaFields = avroSchema.fields;
	delete avroSchema.fields;
	return Object.assign({}, avroSchema, {
		fields: schemaFields
	});
};

const handleRecursiveSchema = (schema, avroSchema, parentSchema = {}, udt) => {
	if (schema.oneOf) {
		handleChoice(schema, 'oneOf', udt);
	}
	if (schema.anyOf) {
		handleChoice(schema, 'anyOf', udt);
	}
	if (schema.allOf) {
		handleChoice(schema, 'allOf', udt);
	}
	schema.type = schema.type || getTypeFromReference(schema);
	if (schema.subtype && schema.type !== 'map') {
		schema.logicalType = schema.subtype;
		delete schema.subtype;
	}

	for (let prop in schema) {
		switch (prop) {
			case 'type':
				handleType(schema, avroSchema, udt);
				break;
			case 'properties':
				handleFields(schema, avroSchema, udt);
				break;
			case 'items':
				handleItems(schema, avroSchema, udt);
				break;
			case 'default':
				handleDefault(schema, avroSchema, udt);
				break;
			default:
				handleOtherProps(schema, prop, avroSchema, udt);
		}
	}
	handleComplexTypeStructure(avroSchema, parentSchema);
	handleSchemaName(avroSchema, parentSchema);
	avroSchema = reorderAttributes(avroSchema);
	handleEmptyNestedObjects(avroSchema);

	handleRequired(parentSchema, avroSchema, schema);

	addMetaPropertiesToType(avroSchema, schema);

	return;
};

const handleMergedChoice = (schema, udt) => {
	const meta = schema.allOf_meta;
	const separateChoices = meta.reduce((choices, meta) => {
		const items = schema.allOf.filter(item => {
			const ids = _.get(meta, 'ids', []);

			return ids.includes(item.GUID);
		});
		const type = _.get(meta, 'choice');
		if (!type || type === 'allOf') {
			return choices.concat({ items, type: 'allOf', meta });
		}

		const choiceItems = _.first(items)[type];

		return choices.concat({ items: choiceItems, type, meta });
		

	}, []);
	
	const newSchema = separateChoices.reduce((updatedSchema, choiceData) => {
		const choiceType = choiceData.type;
		const schemaWithChoice = Object.assign({}, removeChoices(updatedSchema), {
			[choiceType]: choiceData.items,
			[`${choiceType}_meta`]: choiceData.meta
		});

		handleChoice(schemaWithChoice, choiceType, udt);

		return schemaWithChoice;
	}, schema);

	return Object.assign(schema, newSchema);
};

const removeChoices = schema => _.omit(schema, [
	'oneOf', 'oneOf_meta', 'allOf', 'allOf_meta', 'anyOf', 'anyOf_meta', 'not', 'not_meta'
]);

const handleChoice = (schema, choice, udt) => {
	const convertDefaultMetaFieldType = (type, value) => {
		if (type === 'null' && value === 'null') {
			return null;
		}
		if (type === 'number' && !isNaN(value)) {
			return Number(value);
		}
		
		return value;
	};
	
	const choiceRawMeta = schema[`${choice}_meta`];
	if (_.isArray(choiceRawMeta)) {
		return handleMergedChoice(schema, udt);
	}

	let choiceMeta = {};
	let allSubSchemaFields = [];
	
	if (choiceRawMeta) {
		choiceMeta = Object.keys(choiceRawMeta).reduce((choiceMeta, prop) => {
			if (ADDITIONAL_CHOICE_META_PROPS.includes(prop) && typeof choiceRawMeta[prop] !== "undefined") {
				return Object.assign({}, choiceMeta, {
					[prop]: choiceRawMeta[prop]
				});
			}
			
			return choiceMeta;
		}, {});

		const choiceMetaName = choiceRawMeta.code || choiceRawMeta.name;

		if (choiceMetaName) {
			choiceMeta.name = choiceMetaName;
		}
	}
	
	schema[choice].forEach((subSchema) => {
    	if (subSchema.oneOf) {
    		handleChoice(subSchema, "oneOf", udt);
    	}
		if (subSchema.anyOf) {
			handleChoice(subSchema, "anyOf", udt);
		}
    	if (subSchema.allOf) {
    	  	handleChoice(subSchema, "allOf", udt);
    	}

    	if (subSchema.type === "array") {
			const arrayItems = Array.isArray(subSchema.items) ? subSchema.items : [subSchema.items];
    		allSubSchemaFields = allSubSchemaFields.concat(
    		  	arrayItems.reduce((items, item) => {
					if(!_.isEmpty(item)) {
						return [...items, {...item}]
					}
    		  	  	return items;
    		  	}, [])
			);	

			return;
		}

		allSubSchemaFields = allSubSchemaFields.concat(
    		Object.keys(subSchema.properties || {}).map((item) => {
    			return Object.assign(
    				{
    				  name: item,
    				},
    				subSchema.properties[item]
    			);
    		})
    	);
 	});

	let multipleFieldsHash = {};

	if ((schema.type !== "array") || (schema.type === "array" && !schema.items)) {
		allSubSchemaFields.forEach(field => {
			const fieldName = choiceMeta.name || field.name;
			if (!multipleFieldsHash[fieldName]) {
				if (!_.isUndefined(choiceMeta.default)) {
					choiceMeta.default = convertDefaultMetaFieldType(field.type, choiceMeta.default);
				}

				if (choiceMeta.default === '') {
					delete choiceMeta.default;
				}

				multipleFieldsHash[fieldName] = Object.assign({}, choiceMeta, {
					name: fieldName,
					type: [],
					choiceMeta
				});
			}
			let multipleField = multipleFieldsHash[fieldName];
			const filedType = field.type || getTypeFromReference(field) || DEFAULT_TYPE;

			if (!_.isArray(multipleField.type)) {
				multipleField.type = [multipleField.type];
			}

			if (!_.isArray(multipleField.type)) {
				multipleField.type = [multipleField.type];
			}

			let newField = {};

			handleRecursiveSchema(field, newField, {}, udt);

			if (isComplexType(filedType)) {
				newField.name = newField.name || field.name || fieldName;
				newField.type.name = newField.type.name || field.name || fieldName;
				newField.type = reorderAttributes(newField.type);
				multipleField.type.push(newField);
			} else if (Object(newField.type) === newField.type) {
				newField.name = newField.name || field.name || fieldName;
				multipleField.type = multipleField.type.concat([newField]);
			} else if (Array.isArray(filedType)) {
				multipleField.type = multipleField.type.concat(filedType);
			} else {
				multipleField.type = multipleField.type.concat([filedType]);
			}

			multipleField.type = _.uniq(multipleField.type);
			if (multipleField.type.length === 1) {
				multipleField.type = _.first(multipleField.type);
			}
		});
	}

	if(schema.type === 'array') {
		schema.items = (schema.items || []).filter(item => !_.isEmpty(item)).concat(allSubSchemaFields);
	} else {
		schema.properties = addPropertiesFromChoices(schema.properties, multipleFieldsHash);
	}
};

const getChoiceIndex = choice => _.get(choice, 'choiceMeta.index');

const addPropertiesFromChoices = (properties, choiceProperties) => {
	if (_.isEmpty(choiceProperties)) {
		return properties || {};
	}

	const sortedKeys = Object.keys(choiceProperties).sort((a, b) => {
		return getChoiceIndex(a) - getChoiceIndex(b)
	});

	return sortedKeys.reduce((sortedProperties, choicePropertyKey) => {
		const choiceProperty = choiceProperties[choicePropertyKey];
		const choicePropertyIndex = getChoiceIndex(choiceProperty);
		if (_.isEmpty(sortedProperties)) {
			return { [choicePropertyKey]: choiceProperty };
		}

		if (
			_.isUndefined(choicePropertyIndex) ||
			Object.keys(sortedProperties).length <= choicePropertyIndex
		) {
			return Object.assign({}, sortedProperties, {
				[choicePropertyKey]: choiceProperty
			});
		}

		return Object.keys(sortedProperties).reduce((result, propertyKey, index, keys) => {
			const currentIndex = getChoiceIndex(sortedProperties[propertyKey]);
			const hasSameChoiceIndex = !_.isUndefined(currentIndex) && currentIndex <= choicePropertyIndex;
			if (index < choicePropertyIndex || result[choicePropertyKey] || hasSameChoiceIndex) {
				if (!result[choicePropertyKey] && keys.length === index + 1) {
					return Object.assign({}, result, {
						[propertyKey] : sortedProperties[propertyKey],
						[choicePropertyKey]: choiceProperty,
					});
				}
				return Object.assign({}, result, {
					[propertyKey] : sortedProperties[propertyKey]
				});
			}

			return Object.assign({}, result, {
				[choicePropertyKey]: choiceProperty,
				[propertyKey] : sortedProperties[propertyKey]
			});
		}, {});
	}, properties || {});
};

const isRequired = (parentSchema, name) => {
	if (!Array.isArray(parentSchema.required)) {
		return false;
	} else {
		return parentSchema.required.some(requiredName => prepareName(requiredName) === name);
	}
};

const handleRequired = (parentSchema, avroSchema) => {
	const isReference = _.isObject(avroSchema.type);
	if (isReference && !_.isUndefined(avroSchema.default)) {
		return;
	}

	if (isRequired(parentSchema, avroSchema.name)) {
		delete avroSchema.default;
	}
};

const handleType = (schema, avroSchema, udt) => {
	if (Array.isArray(schema.type)) {
		avroSchema = handleMultiple(avroSchema, schema, 'type', udt);
	} else {
		avroSchema = getFieldWithConvertedType(avroSchema, schema, schema.type, udt);
	}
	if (_.isPlainObject(avroSchema.type)) {
		avroSchema.type = reorderAttributes(avroSchema.type)
	}
};

const handleMultiple = (avroSchema, schema, prop, udt) => {
	const commonAttributes = ["aliases", "description", "default"];
	avroSchema[prop] = schema[prop].map(type => {
		if (type && typeof type === 'object') {
			return type.type;
		} else {
			const field = getFieldWithConvertedType({}, schema, type, udt);
			if (isComplexType(type)) {
				const fieldName = field.typeName || schema.name;
				const fieldProperties = getMultipleComplexTypeProperties(schema, type);

				Object.keys(fieldProperties).forEach(prop => {
					delete schema[prop];
				});

				return Object.assign({
					name: fieldName,
					type
				}, fieldProperties)
			}

			const fieldAttributesKeys = PRIMITIVE_FIELD_ATTRIBUTES.filter(attribute => field[attribute]);
			if (_.isEmpty(fieldAttributesKeys)) {
				return field.type;
			}
			
			const attributes = fieldAttributesKeys.reduce((attributes, key) => {
				return Object.assign({}, attributes, {
					[key]: field[key]
				});
			}, {});

			return Object.assign({
				type: field.type
			}, attributes);
		}
	});

	const fieldProperties = commonAttributes.reduce((fieldProps, prop) => {
		if (schema[prop]) {
			if(prop === 'description') {
				return {
					...fieldProps,
					doc: schema[prop],
				}
			}

			return Object.assign({}, fieldProps, {
				[prop]: schema[prop]
			});
		}

		return fieldProps;
	}, {});
	return Object.assign(avroSchema, fieldProperties);
};

const getMultipleComplexTypeProperties = (schema, type) => {
	const commonComplexFields = ["default"];
	const allowedComplexFields = {
		"enum": [
			"symbols",
			"namespace"
		],
		"fixed": [
			"size",
			"namespace",
			"logicalType",
			"precision",
			"scale"
		],
		"array": ["items"],
		"map": ["values"],
		"record": ["fields"]
	};

	const currentTypeFields = commonComplexFields.concat(allowedComplexFields[type] || []);

	const fieldProperties = currentTypeFields.reduce((fieldProps, prop) => {
		if (schema[prop]) {
			return Object.assign({}, fieldProps, {
				[prop]: schema[prop]
			});
		}

		return fieldProps;
	}, {});

	return fieldProperties;
}

const getFieldWithConvertedType = (schema, field, type) => {
	switch(type) {
		case 'string':
		case 'boolean':
		case 'bytes':
		case 'null':
		case 'array':
			return Object.assign(schema, getField(field, type));
		case 'record':
		case 'enum':
		case 'fixed':
			return Object.assign(schema, getField(field, type), {
				typeName: field.typeName 
			});
		case 'number':
			return Object.assign(schema, getNumberField(field));
		case 'map':
			return Object.assign(schema, {
				type,
				values: getValues(type, field.subtype)
			});
		default:
			return Object.assign(schema, { type });
	}
};

const getTypeFromUdt = (type, udt, schema) => {
    let result;

    if (isUdtUsed(type, udt)) {
        result = getTypeWithNamespace(type, udt);
    }

    const udtItem = cloneUdtItem(udt[type]);

    if (!result) {
        if (!isDefinitionTypeValidForAvroDefinition(udtItem)) {
            result = udtItem;
        } else {
            useUdt(type, udt);

            if (Array.isArray(udtItem)) {
                result = udtItem.map(udtItemType => replaceUdt(udtItemType, udt));
            } else {
                result = replaceUdt(udtItem, udt);
            }
        }
    }

    if (_.includes(AVRO_TYPES, type) && _.isEqual(result, schema)) {
        return type;
    }

    return result;
};

const prepareTypeFromUDT = (typeFromUdt) => {
	if (_.isObject(typeFromUdt) && typeFromUdt.logicalType) {
		return { ...typeFromUdt };
	}
	return { type: typeFromUdt || DEFAULT_TYPE };
}

const getTypeWithNamespace = (type, udt) => {
	const udtItem = udt[type];

	if (!udtItem) {
		return type;
	}

	if (!udtItem.namespace) {
		return type;
	}

	return udtItem.namespace + '.' + type;
};

const useUdt = (type, udt) => {
	udt[type] = cloneUdtItem(udt[type]);
	
	udt[type].used = true;
};

const isUdtUsed = (type, udt) => {
	return !udt[type] || udt[type].used;
};

const isDefinitionTypeValidForAvroDefinition = (definition) => {
	const validTypes = ['record', 'enum', 'fixed', 'array'];
	if (typeof definition === 'string') {
		return validTypes.includes(definition);
	} else if (Array.isArray(definition)) {
		return definition.some(isDefinitionTypeValidForAvroDefinition);
	} else {
		return validTypes.includes(definition.type);
	}
}

const cloneUdtItem = (udt) => {
	if (typeof udt === 'string') {
		return udt;
	} else if (Array.isArray(udt)) {
		return [...udt];
	} else {
		return Object.assign({}, udt);
	}
}

const getTypeFromReference = (schema) => {
	if (!schema.$ref) {
		return;
	}

	if(_.includes(schema.$ref, '#')) {
		return prepareName(schema.$ref.split('/').pop() || '');
	}

	return schema.$ref
};

const getValues = (type, subtype) => {
	const regex = new RegExp('\\' + type + '<(.*?)\>');
	return subtype.match(regex)[1] || DEFAULT_TYPE;
};

const handleFields = (schema, avroSchema, udt) => {
	avroSchema.fields = Object.keys(schema.properties).map(key => {
		let field = schema.properties[key];
		let avroField = Object.assign({}, { name: key });
		handleRecursiveSchema(field, avroField, schema, udt);
		return avroField;
	});
};

const handleItems = (schema, avroSchema, udt) => {
	if (!schema.items) {
		schema.items = [];
	}
	schema.items = !Array.isArray(schema.items) ? [schema.items] : schema.items;

	const items = schema.items
		.map(schemaItem => {
			let itemData = {};
			const schemaItemName = schemaItem.arrayItemCode || schemaItem.arrayItemName || schemaItem.code || schemaItem.name;
			handleRecursiveSchema(schemaItem, itemData, avroSchema, udt);

			if(isComplexType(itemData.type)) {
				itemData = {};
				handleRecursiveSchema(schemaItem, itemData, schema, udt);
			}

			if(schemaItemName) {
				itemData.name = schemaItemName;
			}
			
			if(itemData.type.type){
				Object.assign(itemData, itemData.type);
			}

			return itemData;
		});

	const mappedItems = items.map(item => {
		if (item.type === 'null') {
			return 'null';
		}
		return item;
	});
	avroSchema.items = getUniqueItemsInArray(mappedItems);
	if(avroSchema.items.length === 1) {
		if (schema.items[0].$ref && !avroSchema.items[0].name) {
			avroSchema.items = avroSchema.items[0].type;
		} else {
			avroSchema.items = avroSchema.items[0];
		}
	}
};

const getUniqueItemsInArray = (items) => {
	return items.reduce((allItems, item) => {
		if (typeof item === 'string') {
			if (!allItems.includes(item)) {
				return [ ...allItems, item];
			}
			return allItems;
		}
		if(!isComplexType(item.type)){
			if(!allItems.some(addedItem => addedItem.type === item.type)) {
				return [ ...allItems, item];
			}
			return allItems;
		}
		if(!allItems.some(addedItem => addedItem.name === item.name)){
			return [ ...allItems, item];
		}
		return allItems;
	}, [])
}

const handleDefault = (schema, avroSchema, udt) => {
	const value = getDefault(schema.type, schema['default']);
	if (_.isArray(schema.type)) {
		avroSchema['default'] = value;
		return;
	}

	const allowedProperties = getAllowedPropertyNames(schema.type, schema, udt);
	if (allowedProperties.includes('default')) {
		avroSchema['default'] = value;
	}
};

const handleOtherProps = (schema, prop, avroSchema, udt) => {
	const allowedProperties = getAllowedPropertyNames(schema.type, schema, udt);
	if (!allowedProperties.includes(prop)) {
		return;
	}

	if(prop === 'description') {
		avroSchema.doc = schema[prop];

		return;
	}

	avroSchema[prop] = schema[prop];
};

const getDefault = (type, value) => {
	const defaultType = _.isArray(type) ? _.first(type) : type;
	if (!_.isString(defaultType)) {
		return value;
	}

	if (defaultType === 'null' && value === 'null') {
		return null;
	}

	return value;
};

const handleComplexTypeStructure = (avroSchema, parentSchema) => {
	const rootComplexProps = ['doc', 'default'];
	const isParentArray = parentSchema && parentSchema.type && parentSchema.type === 'array';

	if (!isParentArray && isComplexType(avroSchema.type)) {
		const name = avroSchema.name;
		const schemaContent = Object.assign({}, avroSchema, { name: avroSchema.typeName || avroSchema.name });

		Object.keys(avroSchema).forEach(function(key) { delete avroSchema[key]; });

		if ((schemaContent.type === 'array' || schemaContent.type === 'map') && name) {
			delete schemaContent.name;
		}
		delete schemaContent.arrayItemName;
		delete schemaContent.typeName;

		avroSchema.name = name;
		avroSchema.type = schemaContent;

		rootComplexProps.forEach(prop => {
			if (schemaContent.hasOwnProperty(prop)) {
				avroSchema[prop] = schemaContent[prop];
				delete schemaContent[prop];
			}
		});
	}
};

const handleSchemaName = (avroSchema, parentSchema) => {
	if (!avroSchema.name && isComplexType(avroSchema.type) && avroSchema.type !== 'array') {
		avroSchema.name = avroSchema.arrayItemName || parentSchema.name || getDefaultName();
	}

	if (avroSchema.name) {
		avroSchema.name = prepareName(avroSchema.name);
	}

	if(avroSchema.type && avroSchema.type.name) {
		avroSchema.type.name = prepareName(avroSchema.type.name);
	}

	delete avroSchema.arrayItemName;
};

const prepareName = (name) => name
	.replace(VALID_FULL_NAME_REGEX, '_')
	.replace(VALID_FIRST_NAME_LETTER_REGEX, '_');

const getDefaultName = () => {
	if (nameIndex) {
		return `${DEFAULT_NAME}_${nameIndex++}`;
	} else {
		nameIndex++;
		return  DEFAULT_NAME;
	}
};

const reorderAttributes = (avroSchema) => {
	return _.flow([
		setPropertyAsFirst('type'),
		setPropertyAsFirst('doc'),
		setPropertyAsFirst('name')
	])(avroSchema);
};

const setPropertyAsFirst = key => avroSchema => {
	let objKeys = Object.keys(avroSchema);
	if (objKeys.includes(key)) {
		objKeys = [key, ...objKeys.filter(item => item !== key)];
	}

	objKeys.forEach(prop => {
		const tempValue = avroSchema[prop];
		delete avroSchema[prop];
		avroSchema[prop] = tempValue;
	});

	return avroSchema;
}

const isComplexType = (type) => {
	if (!type) {
		return false;
	}
	return ['record', 'array', 'fixed', 'enum', 'map'].includes(type);
};

const handleEmptyNestedObjects = (avroSchema) => {
	if (avroSchema.type && avroSchema.type === 'record') {
		avroSchema.fields = (avroSchema.fields) ? avroSchema.fields : [];
	} else if (avroSchema.type && avroSchema.type === 'array') {
		avroSchema.items = (avroSchema.items) ? avroSchema.items : DEFAULT_TYPE;
	}
};

const getTargetFieldLevelPropertyNames = (type, data) => {
	if (!fieldLevelConfig.structure[type]) {
		return [];
	}

	return fieldLevelConfig.structure[type].filter(property => {
		if (typeof property === 'object' && property.isTargetProperty) {
			if (property.dependency) {
				const dependencyKey = resolveKey(type, property.dependency.key);
				return (data[dependencyKey] == property.dependency.value);
			} else {
				return true;
			}
		}

		return false;
	}).map(property => resolveKey(type, property));
};

const getAllowedPropertyNames = (type, data, udt) => {
	if (udt && udt[type] && type !== _.get(udt[type], 'type')) {
		return getAllowedPropertyNames(_.get(udt[type], 'type'), data, udt);
	}
	if(type === 'root') {
		return ['aliases', 'description'];
	}
	if (!fieldLevelConfig.structure[type]) {
		return [];
	}
	const isAllowed = (property) => {
		if (typeof property === 'string') {
			return ADDITIONAL_PROPS.includes(property)
		} else if (Object(property) === property) {
			return ADDITIONAL_PROPS.includes(property.propertyKeyword);
		} else {
			return false;
		}
	};

	return fieldLevelConfig.structure[type].filter(property => {
		if (!isAllowed(property)) {
			return false;
		}
		
		if (typeof property !== 'object') {
			return true;
		}
		if (!property.dependency) {
			return true;
		}

		const dependencyKey = resolveKey(type, property.dependency.key);

		return (data[dependencyKey] === property.dependency.value);
	}).map(property => _.isString(property) ? property : property.propertyKeyword)
	.map(name => resolveKey(type, name));
};

const resolveKey = (type, key) => (key === 'subtype' && type !== 'map') ? 'logicalType' : key;

const handleTargetProperties = (schema, avroSchema) => {
	if (schema.type) {
		const targetProperties = getTargetFieldLevelPropertyNames(schema.type, schema);
		targetProperties.forEach(prop => {
			if (_.isString(prop)) {
				return avroSchema[prop] = schema[prop];
			}
			const keyword = _.get(prop, 'propertyKeyword', '');
			if (!keyword) {
				return;
			}
			avroSchema[keyword] = schema[keyword];
		});
	}
};

const getNumberField = field => {
	const type = field.mode || 'int';

	return getField(field, type);
};

const getField = (field, type) => {
	const logicalType = field.logicalType;
	const correctLogicalTypes = _.get(LOGICAL_TYPES_MAP, type, []);
	const logicalTypeIsCorrect = correctLogicalTypes.includes(logicalType);
	const fieldWithType = { ...field, type };
	let filteredField = {};
	handleTargetProperties(fieldWithType, filteredField);

	const isDuration = field.type === 'fixed' && field.logicalType === 'duration';
	const size = isDuration ? field.durationSize : field.size;

	if (!logicalTypeIsCorrect) {
		return {
			type,
			...filteredField,
			...(!_.isUndefined(size) && { size: Number(size) }),
		};
	}

	return {
		type: {
			type,
			logicalType,
			...(filteredField.precision && { precision: filteredField.precision }),
			...(filteredField.scale && { scale: filteredField.scale }),
			...(!_.isUndefined(size) && { size: Number(size) }),
		},
		..._.omit(filteredField, ['scale', 'precision', 'size', 'durationSize',]),
	};
};

const replaceUdt = (avroSchema, udt) => {
	const convertType = (schema) => {
		if (Array.isArray(schema.type)) {
			const type = schema.type.map(type => getTypeFromUdt(type, udt, schema));

			return Object.assign({}, schema, { type });
		} else if (typeof schema.type === 'string') {
			const type = getTypeFromUdt(schema.type, udt, schema);

			return Object.assign({}, schema, { type });
		} else {
			return schema;
		}
	};
	const extractArrayItem = (schema) => {
		if (typeof schema.items === 'string') {
			return {
				...schema,
				items: getTypeFromUdt(schema.items, udt, schema),
			};
		}
		const items = schema.items ? convertType(schema.items) : [];
		const previousType = _.get(schema, 'items.type', items.type);
		const convertedType = items.type;

		if (!convertedType || convertedType === previousType) {
			return schema;
		}
		
		return Object.assign({}, schema, { items: convertedType });
	};

	return mapAvroSchema(avroSchema, (schema) => {
		if (schema.type === 'array') {
			return extractArrayItem(schema);
		} else {
			return convertType(schema);
		}
	});
};

const mapAvroSchema = (avroSchema, iteratee) => {
	avroSchema = iteratee(avroSchema);
	
	if (_.isArray(avroSchema.fields)) {
		const fields = avroSchema.fields.map(schema => mapAvroSchema(schema, iteratee));

		avroSchema = Object.assign({}, avroSchema, { fields });
	}

	if (_.isPlainObject(avroSchema.type)) {
		const type = mapAvroSchema(avroSchema.type, iteratee);

		avroSchema = Object.assign({}, avroSchema, { type });
	}

	if (_.isArray(avroSchema.type)) {
		const type = avroSchema.type.map(type => {
			if (!_.isPlainObject(type)) {
				return type;
			}

			return mapAvroSchema(type, iteratee);
		});

		avroSchema = Object.assign({}, avroSchema, { type });
	}

	if (_.isPlainObject(avroSchema.items)) {
		const items = mapAvroSchema(avroSchema.items, iteratee);

		avroSchema = Object.assign({}, avroSchema, { items });
	}

	return avroSchema;
};

const getMetaProperties = (metaProperties) => {
	const metaValueKeyMap = {
		'avro.java.string': 'metaValueString',
		'java-element': 'metaValueElement',
		'java-element-class': 'metaValueElementClass',
		'java-class': 'metaValueClass',
		'java-key-class': 'metaValueKeyClass'
	};

	return metaProperties.reduce((props, property) => {
		const metaValueKey = _.get(metaValueKeyMap, property.metaKey, 'metaValue');

		return Object.assign(props, { [property.metaKey]: property[metaValueKey] });
	}, {});
};

const getTypeWithMeta = (type, meta) => {
	if (typeof type !== 'string') {
		return Object.assign({}, type, meta);
	} else {
		return Object.assign({ type }, meta);
	}
};

const getMultipleTypeWithMeta = (types, meta) => {
	return types.map(type => {
		if (type === 'null') {
			return type;
		}

		return getTypeWithMeta(type, meta);
	});
};

const addMetaPropertiesToType = (avroSchema, jsonSchema) => {
	if (!Array.isArray(jsonSchema.metaProps) || !jsonSchema.metaProps.length) {
		return avroSchema;
	}

	const meta = getMetaProperties(jsonSchema.metaProps);

	if (Array.isArray(avroSchema.type)) {
		avroSchema.type = getMultipleTypeWithMeta(avroSchema.type, meta);
	} else {
		avroSchema.type = getTypeWithMeta(avroSchema.type, meta);
	}

	return avroSchema;
};
