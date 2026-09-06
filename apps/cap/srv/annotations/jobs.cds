using JobsService from '../jobs-service';

/**
 * Background jobs on the Admin launchpad. (BETA)
 *
 * The columns are chosen for one question — "did it run, and did it work?" —
 * because that is what someone opens this screen to find out. The lease
 * columns are shown rather than hidden: when a job has not run, the reason is
 * usually that another instance holds it, and an operator who cannot see that
 * has no way to tell a stuck job from an idle one.
 */
annotate JobsService.ScheduledJobs with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Scheduled Job',
      TypeNamePlural: 'Scheduled Jobs',
      Title         : { Value: jobName },
      Description   : { Value: description }
    },
    SelectionFields: [ jobName, isActive, lastRunStatus ],
    LineItem: [
      { $Type: 'UI.DataField', Value: jobName,        Label: 'Job' },
      { $Type: 'UI.DataField', Value: isActive,       Label: 'Enabled' },
      { $Type: 'UI.DataField', Value: runAtHour,      Label: 'Daily At' },
      { $Type: 'UI.DataField', Value: intervalMinutes, Label: 'Every (min)' },
      { $Type: 'UI.DataField', Value: lastRunAt,      Label: 'Last Run' },
      { $Type: 'UI.DataField', Value: lastRunStatus,  Label: 'Result',
        Criticality: lastRunCriticality },
      { $Type: 'UI.DataField', Value: lastRunMs,      Label: 'Took (ms)' },
      { $Type: 'UI.DataField', Value: failureCount,   Label: 'Failures in a Row' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Schedule',  Target: '@UI.FieldGroup#Schedule' },
      { $Type: 'UI.ReferenceFacet', Label: 'Last run',  Target: '@UI.FieldGroup#LastRun' },
      { $Type: 'UI.ReferenceFacet', Label: 'Lease',     Target: '@UI.FieldGroup#Lease' }
    ],
    FieldGroup#Schedule: { Data: [
      { Value: jobName }, { Value: description }, { Value: isActive },
      { Value: runAtHour }, { Value: intervalMinutes }
    ]},
    FieldGroup#LastRun: { Data: [
      { Value: lastRunAt }, { Value: lastRunStatus }, { Value: lastRunMs },
      { Value: lastRunMessage }, { Value: failureCount }
    ]},
    FieldGroup#Lease: { Data: [
      { Value: lockedBy }, { Value: lockedUntil }
    ]}
  }
);

annotate JobsService.ScheduledJobs with {
  jobName         @title: 'Job name — used by the code, do not rename';
  description     @title: 'What this job does';
  isActive        @title: 'Enabled — a disabled job is skipped, not deleted';
  runAtHour       @title: 'Hour of day to run (0–23, local time). Leave empty to use the interval';
  intervalMinutes @title: 'Minutes between runs, when no hour is set';
  lastRunAt       @readonly @title: 'When it last ran';
  lastRunStatus   @readonly @title: 'How it went';
  lastRunMessage  @readonly @title: 'What it reported';
  lastRunMs       @readonly @title: 'How long it took';
  failureCount    @readonly @title: 'Consecutive failures — resets on a success';
  lockedBy        @readonly @title: 'Instance currently holding the job';
  lockedUntil     @readonly @title: 'Lease expires — an instance that dies stops renewing and the job frees itself';
}

/**
 * Colour the result column.
 *
 * 3 is positive, 1 negative in Fiori's criticality scale. Worth the virtual
 * field: a failed overnight run has to be visible in a scan of the list, not
 * something you find by reading each row.
 */
annotate JobsService.ScheduledJobs with {
  lastRunStatus @Common.Text: lastRunStatus;
};

annotate JobsService.JobRuns with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Job Run',
      TypeNamePlural: 'Job Runs',
      Title         : { Value: jobName },
      Description   : { Value: summary }
    },
    SelectionFields: [ jobName, status ],
    LineItem: [
      { $Type: 'UI.DataField', Value: startedAt,  Label: 'Started' },
      { $Type: 'UI.DataField', Value: jobName,    Label: 'Job' },
      { $Type: 'UI.DataField', Value: status,     Label: 'Result' },
      { $Type: 'UI.DataField', Value: durationMs, Label: 'Took (ms)' },
      { $Type: 'UI.DataField', Value: summary,    Label: 'What it did' },
      { $Type: 'UI.DataField', Value: instance,   Label: 'Instance' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Run', Target: '@UI.FieldGroup#Run' }
    ],
    FieldGroup#Run: { Data: [
      { Value: jobName }, { Value: startedAt }, { Value: finishedAt },
      { Value: durationMs }, { Value: status }, { Value: instance },
      { Value: summary }, { Value: errorDetail }
    ]}
  }
);

annotate JobsService.JobRuns with {
  jobName     @title: 'Job';
  startedAt   @title: 'Started';
  finishedAt  @title: 'Finished';
  durationMs  @title: 'Duration (ms)';
  status      @title: 'Result';
  instance    @title: 'Which instance ran it';
  summary     @title: 'What it did';
  errorDetail @title: 'Error detail, when it failed';
}

/**
 * Watchers on the Admin launchpad. (BETA)
 *
 * "Currently breached" leads the columns because it answers the question
 * someone opens this screen with. A watcher that has not alerted is either
 * fine or already alerted, and those need opposite responses.
 */
annotate JobsService.Watchers with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Watcher',
      TypeNamePlural: 'Watchers',
      Title         : { Value: name },
      Description   : { Value: objectCode }
    },
    SelectionFields: [ objectCode, warehouseID, isActive, lastBreached ],
    LineItem: [
      { $Type: 'UI.DataField', Value: name,          Label: 'Watcher' },
      { $Type: 'UI.DataField', Value: objectCode,    Label: 'Object' },
      { $Type: 'UI.DataField', Value: warehouseID,   Label: 'Plant' },
      { $Type: 'UI.DataField', Value: measure,       Label: 'Measure' },
      { $Type: 'UI.DataField', Value: comparison,    Label: 'When' },
      { $Type: 'UI.DataField', Value: threshold,     Label: 'Threshold' },
      { $Type: 'UI.DataField', Value: lastValue,     Label: 'Last Value' },
      { $Type: 'UI.DataField', Value: lastBreached,  Label: 'Breached',
        Criticality: breachCriticality },
      { $Type: 'UI.DataField', Value: lastCheckedAt, Label: 'Last Checked' },
      { $Type: 'UI.DataField', Value: isActive,      Label: 'Active' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'What to watch', Target: '@UI.FieldGroup#What' },
      { $Type: 'UI.ReferenceFacet', Label: 'The rule',      Target: '@UI.FieldGroup#Rule' },
      { $Type: 'UI.ReferenceFacet', Label: 'State',         Target: '@UI.FieldGroup#State' }
    ],
    FieldGroup#What: { Data: [
      { Value: name }, { Value: objectCode }, { Value: warehouseID },
      { Value: filterText }, { Value: owner }, { Value: isActive }
    ]},
    FieldGroup#Rule: { Data: [
      { Value: measure }, { Value: fieldName }, { Value: comparison }, { Value: threshold }
    ]},
    FieldGroup#State: { Data: [
      { Value: lastBreached }, { Value: lastValue }, { Value: lastCheckedAt },
      { Value: lastAlertedAt }, { Value: alertCount }, { Value: lastError }
    ]}
  }
);

annotate JobsService.Watchers with {
  name          @title: 'What to call this alert';
  objectCode    @title: 'Business object to read — must be registered and active';
  warehouseID   @title: 'Plant, or leave empty for all';
  filterText    @title: 'Optional narrowing, e.g. a material number';
  measure       @title: 'ROW_COUNT needs no field; FIELD_MIN/MAX/SUM read the field below';
  fieldName     @title: 'Field to measure — only for FIELD_ measures';
  comparison    @title: 'LT, LTE, GT, GTE, EQ, NE';
  threshold     @title: 'The line the value must cross';
  owner         @title: 'Who cares about this one';
  lastBreached  @readonly @title: 'Breached right now — alerts fire on entering this state, not while in it';
  lastValue     @readonly @title: 'Value at the last check';
  lastCheckedAt @readonly @title: 'Last checked';
  lastAlertedAt @readonly @title: 'Last alerted';
  alertCount    @readonly @title: 'Times alerted';
  lastError     @readonly @title: 'Why the last check failed, if it did';
}
