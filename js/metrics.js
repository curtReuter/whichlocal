/**
 * Metric definitions for the Which Local map — one entry per selectable data
 * value scraped from unionpayscales.com (IBEW electricians). Each entry gives a
 * label, a unit line, a one-line hint, and a `format` used by the list, the
 * tooltips and the legend.
 *
 * The keys here MUST match the field names on the PocketBase `locals`
 * collection (see js/dataSource.js).
 */

const perHour = (v) => `$${v.toFixed(2)}/hr`;

export const metrics = {
  total_package: {
    label: 'Total package',
    unit: '$/hr incl. benefits',
    hint: 'Total hourly compensation package — base wage plus all benefit contributions',
    format: perHour,
  },
  hourly_rate: {
    label: 'Hourly rate',
    unit: '$/hr base wage',
    hint: 'Journeyman base hourly wage',
    format: perHour,
  },
  yearly_salary: {
    label: 'Yearly salary',
    unit: '$/yr at 40hr weeks',
    hint: 'Base wage annualised over 40-hour weeks',
    format: (v) => `$${Math.round(v).toLocaleString('en-US')}`,
  },
  col_pct: {
    label: 'Cost of living',
    unit: '% of national avg',
    hint: 'Local cost of living as a percentage of the US national average',
    format: (v) => `${Math.round(v)}%`,
  },
  defined_pension: {
    label: 'Defined pension',
    unit: '$/hr contribution',
    hint: 'Employer contribution to the defined-benefit pension',
    format: perHour,
  },
  contribution_pension: {
    label: 'Contribution pension',
    unit: '$/hr contribution',
    hint: 'Employer contribution to the defined-contribution pension',
    format: perHour,
  },
  k401: {
    label: '401(k)',
    unit: '$/hr contribution',
    hint: 'Employer 401(k) contribution',
    format: perHour,
  },
  vacation: {
    label: 'Vacation',
    unit: '$/hr contribution',
    hint: 'Vacation / holiday fund contribution',
    format: perHour,
  },
  hw: {
    label: 'Health & welfare',
    unit: '$/hr contribution',
    hint: 'Health & welfare (medical) fund contribution',
    format: perHour,
  },
  nebf_pension: {
    label: 'NEBF pension',
    unit: '$/hr contribution',
    hint: 'National Electrical Benefit Fund pension contribution',
    format: perHour,
  },
  dues: {
    label: 'Union dues',
    unit: '% of gross pay',
    hint: 'Working dues as a percentage of gross pay',
    format: (v) => `${v}%`,
  },
};
