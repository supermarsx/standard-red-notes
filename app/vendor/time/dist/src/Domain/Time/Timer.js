"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Timer = void 0;
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const microtime = require("microtime");
const Time_1 = require("./Time");
class Timer {
    constructor() {
        dayjs.extend(utc);
    }
    /* istanbul ignore next */
    async sleep(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
    getUTCDateNSecondsAhead(n) {
        return dayjs.utc().add(n, 'second').toDate();
    }
    getUTCDateNMinutesAgo(n) {
        return dayjs.utc().subtract(n, 'minute').toDate();
    }
    convertMicrosecondsToTimeStructure(microseconds) {
        const days = Math.floor(microseconds / Time_1.Time.MicrosecondsInADay);
        const hoursLeftOver = microseconds % Time_1.Time.MicrosecondsInADay;
        const hours = Math.floor(hoursLeftOver / Time_1.Time.MicrosecondsInAnHour);
        const minutesLeftOver = microseconds % Time_1.Time.MicrosecondsInAnHour;
        const minutes = Math.floor(minutesLeftOver / Time_1.Time.MicrosecondsInAMinute);
        const secondsLeftOver = microseconds % Time_1.Time.MicrosecondsInAMinute;
        const seconds = Math.floor(secondsLeftOver / Time_1.Time.MicrosecondsInASecond);
        const millisecondsLeftOver = microseconds % Time_1.Time.MicrosecondsInASecond;
        const milliseconds = Math.floor(millisecondsLeftOver / Time_1.Time.MicrosecondsInAMillisecond);
        return {
            days,
            hours,
            minutes,
            seconds,
            milliseconds,
        };
    }
    formatDate(date, format) {
        return dayjs.utc(date).format(format);
    }
    convertDateToMilliseconds(date) {
        return this.convertStringDateToMilliseconds(date.toString());
    }
    convertDateToMicroseconds(date) {
        return this.convertStringDateToMicroseconds(date.toString());
    }
    convertMicrosecondsToSeconds(microseconds) {
        return Math.floor(microseconds / Time_1.Time.MicrosecondsInASecond);
    }
    getTimestampInMicroseconds() {
        return microtime.now();
    }
    getTimestampInSeconds() {
        return this.convertMicrosecondsToSeconds(this.getTimestampInMicroseconds());
    }
    getUTCDate() {
        return dayjs.utc().toDate();
    }
    getUTCDateNDaysAgo(n) {
        return dayjs.utc().subtract(n, 'days').toDate();
    }
    getUTCDateNDaysAhead(n) {
        return dayjs.utc().add(n, 'days').toDate();
    }
    getUTCDateNHoursAgo(n) {
        return dayjs.utc().subtract(n, 'hours').toDate();
    }
    getUTCDateNHoursAhead(n) {
        return dayjs.utc().add(n, 'hours').toDate();
    }
    convertStringDateToDate(date) {
        return dayjs.utc(date).toDate();
    }
    convertDateToISOString(date) {
        return dayjs.utc(date).toISOString();
    }
    convertDateToFormattedString(date, format) {
        return dayjs.utc(date).format(format);
    }
    dateWasNDaysAgo(date) {
        return dayjs.utc().diff(date, 'days');
    }
    convertStringDateToMicroseconds(date) {
        return this.convertStringDateToMilliseconds(date) * Time_1.Time.MicrosecondsInAMillisecond;
    }
    convertStringDateToMilliseconds(date) {
        return dayjs.utc(date).valueOf();
    }
    convertStringDateToSeconds(date) {
        return this.convertMicrosecondsToSeconds(this.convertStringDateToMicroseconds(date));
    }
    convertMicrosecondsToMilliseconds(microseconds) {
        return Math.floor(microseconds / Time_1.Time.MicrosecondsInAMillisecond);
    }
    convertMicrosecondsToStringDate(microseconds) {
        const milliseconds = this.convertMicrosecondsToMilliseconds(microseconds);
        const microsecondsString = microseconds.toString().substring(13);
        return dayjs.utc(milliseconds).format(`YYYY-MM-DDTHH:mm:ss.SSS${microsecondsString}[Z]`);
    }
    convertMicrosecondsToDate(microseconds) {
        return this.convertStringDateToDate(this.convertMicrosecondsToStringDate(microseconds));
    }
}
exports.Timer = Timer;
