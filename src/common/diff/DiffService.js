(function() {
  var module = angular.module('loom_diff_service', []);

  // Private Variables
  var rootScope = null;
  var service_ = null;
  var difflayer_ = null;
  var mapService_ = null;
  var geogitService_ = null;
  var featureDiffService_ = null;
  var translate_ = null;
  var q_ = null;

  module.provider('diffService', function() {
    this.adds = [];
    this.modifies = [];
    this.deletes = [];
    this.conflicts = [];
    this.merges = [];
    this.features = [];
    this.title = 'Diffs';
    this.clickCallback = null;
    this.oldName = null;
    this.newName = null;
    this.mergeDiff = false;
    this.oldCommitId = null;
    this.newCommitId = null;
    this.repoId = null;

    this.$get = function($rootScope, $q, $translate, mapService, geogitService, featureDiffService) {
      rootScope = $rootScope;
      geogitService_ = geogitService;
      featureDiffService_ = featureDiffService;
      translate_ = $translate;
      q_ = $q;
      service_ = this;
      difflayer_ = new ol.layer.Vector({
        metadata: {
          label: translate_('differences'),
          differencesLayer: true
        },
        source: new ol.source.Vector({
          parser: null
        }),
        style: new ol.style.Style({rules: [
          new ol.style.Rule({
            filter: '(geometryType("polygon") || geometryType("multipolygon"))',
            symbolizers: [
              new ol.style.Fill({color: ol.expr.parse('change.fill'), opacity: 0.5}),
              new ol.style.Stroke({color: ol.expr.parse('change.stroke')})
            ]
          }),
          new ol.style.Rule({
            filter: '(geometryType("point") || geometryType("multipoint"))',
            symbolizers: [
              new ol.style.Shape({size: 20,
                fill: new ol.style.Fill({color: ol.expr.parse('change.fill'), opacity: 0.5}),
                stroke: new ol.style.Stroke({color: ol.expr.parse('change.stroke')})
              })
            ]
          })
        ]})
      });
      rootScope.$on('translation_change', function() {
        difflayer_.get('metadata').label = translate_('differences');
      });
      mapService_ = mapService;
      return this;
    };

    this.resolveFeature = function(_feature) {
      var splitFeature = _feature.id.split('/');
      for (var i = 0; i < service_.conflicts.length; i++) {
        var obj = service_.conflicts[i];
        if (obj.layer === splitFeature[0] && obj.feature === splitFeature[1]) {
          obj.resolved = _feature.resolved;
          obj.ours = _feature.ours;
        }
      }
    };

    this.populate = function(_changeList, _repo, oldName, newName) {
      service_.adds = [];
      service_.modifies = [];
      service_.deletes = [];
      service_.conflicts = [];
      service_.merges = [];
      service_.oldName = oldName;
      service_.newName = newName;
      service_.features = _changeList;
      difflayer_.clear();
      mapService_.map.removeLayer(difflayer_);
      mapService_.map.addLayer(difflayer_);
      if (goog.isDefAndNotNull(_changeList)) {
        forEachArrayish(_changeList, function(change) {
          var crs = goog.isDefAndNotNull(change.crs) ? change.crs : null;
          mapService_.map.getLayers().forEach(function(layer) {
            var metadata = layer.get('metadata');
            if (goog.isDefAndNotNull(metadata)) {
              if (goog.isDefAndNotNull(metadata.geogitStore) && metadata.geogitStore === _repo) {
                var splitFeature = change.id.split('/');
                if (goog.isDefAndNotNull(metadata.nativeName) && metadata.nativeName === splitFeature[0]) {
                  if (goog.isDefAndNotNull(metadata.projection)) {
                    crs = metadata.projection;
                  }
                }
              }
            }
          });

          var geom = ol.parser.WKT.read(change.geometry);
          if (goog.isDefAndNotNull(crs)) {
            var transform = ol.proj.getTransform(crs, mapService_.map.getView().getView2D().getProjection());
            geom.transform(transform);
          }
          var olFeature = new ol.Feature();
          olFeature.set('change', DiffColorMap[change.change]);
          olFeature.setGeometry(geom);
          difflayer_.addFeatures([olFeature]);
          change.olFeature = olFeature;
          var splitFeature = change.id.split('/');
          var feature = {
            repo: _repo,
            layer: splitFeature[0],
            feature: splitFeature[1]
          };
          switch (change.change) {
            case 'ADDED':
              service_.adds.push(feature);
              break;
            case 'REMOVED':
              service_.deletes.push(feature);
              break;
            case 'MODIFIED':
              service_.modifies.push(feature);
              break;
            case 'CONFLICT':
              service_.conflicts.push(feature);
              break;
            case 'MERGED':
              service_.merges.push(feature);
              break;
          }
        });
      }
      rootScope.$broadcast('diff_performed', _repo);
    };

    this.performDiff = function(repoId, options) {
      var deferredResponse = q_.defer();
      geogitService_.command(repoId, 'diff', options).then(function(response) {
        service_.clearDiff();
        if (goog.isDefAndNotNull(response.Feature)) {
          service_.mergeDiff = false;
          service_.oldCommitId = options.oldRefSpec;
          service_.newCommitId = options.newRefSpec;
          service_.clickCallback = featureClicked;
          service_.repoId = repoId;
          if (goog.isArray(response.Feature)) {
            service_.populate(response.Feature, geogitService_.getRepoById(repoId).name,
                translate_('from'), translate_('to'));
          } else {
            service_.populate([response.Feature], geogitService_.getRepoById(repoId).name,
                translate_('from'), translate_('to'));
          }
        }
        deferredResponse.resolve(response);
      }, function(reject) {
        //failed to get diff
        console.log(reject);
        deferredResponse.reject();
      });
      return deferredResponse.promise;
    };

    this.clearDiff = function() {
      this.adds = [];
      this.modifies = [];
      this.deletes = [];
      this.conflicts = [];
      this.merges = [];
      this.features = [];
      this.repoId = null;
      this.clickCallback = null;
      mapService_.map.removeLayer(difflayer_);
      rootScope.$broadcast('diff_cleared');
    };

    this.hasDifferences = function() {
      return (
          this.adds.length + this.modifies.length +
          this.deletes.length + this.merges.length +
          this.conflicts.length !== 0
      );
    };

    this.setTitle = function(title) {
      this.title = title;
    };
  });


  function featureClicked(feature) {
    var fid = feature.layer + '/' + feature.feature;
    for (var i = 0; i < service_.features.length; i++) {
      if (fid === service_.features[i].id) {
        featureDiffService_.undoable = true;
        featureDiffService_.leftName = service_.oldName;
        featureDiffService_.rightName = service_.newName;
        featureDiffService_.setFeature(
            service_.features[i], service_.oldCommitId, service_.newCommitId,
            service_.oldCommitId, null, service_.repoId);
        $('#feature-diff-dialog').modal('show');
        service_.currentFeature = service_.features[i];
        break;
      }
    }
  }

}());
